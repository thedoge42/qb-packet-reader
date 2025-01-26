import ServerPlayer from './ServerPlayer.js';
import Votekick from './VoteKick.js';
import { HEADER, ENDC, OKBLUE, OKGREEN } from '../bcolors.js';
import isAppropriateString from '../moderation/is-appropriate-string.js';
import { MODE_ENUM, TOSSUP_PROGRESS_ENUM } from '../../quizbowl/constants.js';
import insertTokensIntoHTML from '../../quizbowl/insert-tokens-into-html.js';
import TossupRoom from '../../quizbowl/TossupRoom.js';
import RateLimit from '../RateLimit.js';

import getRandomTossups from '../../database/qbreader/get-random-tossups.js';
import getSet from '../../database/qbreader/get-set.js';
import getSetList from '../../database/qbreader/get-set-list.js';
import getNumPackets from '../../database/qbreader/get-num-packets.js';

import checkAnswer from 'qb-answer-checker';

const BAN_DURATION = 1000 * 60 * 30; // 30 minutes

export default class ServerTossupRoom extends TossupRoom {
  constructor (name, ownerId, isPermanent = false, categories = [], subcategories = [], alternateSubcategories = []) {
    super(name, categories, subcategories, alternateSubcategories);
    this.ownerId = ownerId;
    this.isPermanent = isPermanent;
    this.checkAnswer = checkAnswer;
    this.getNumPackets = getNumPackets;
    this.getRandomQuestions = getRandomTossups;
    this.getSet = getSet;
    this.getSetList = getSetList;
    this.bannedUserList = new Map();
    this.kickedUserList = new Map();
    this.votekickList = [];
    this.lastVotekickTime = {};

    this.rateLimiter = new RateLimit(50, 1000);
    this.rateLimitExceeded = new Set();
    this.settings = {
      ...this.settings,
      lock: false,
      loginRequired: false,
      public: true,
      controlled: false
    };

    this.getSetList().then(setList => { this.setList = setList; });
    setInterval(this.cleanupExpiredBansAndKicks.bind(this), 5 * 60 * 1000); // 5 minutes
  }

  async message (userId, message) {
    switch (message.type) {
      case 'ban': return this.ban(userId, message);
      case 'chat': return this.chat(userId, message);
      case 'chat-live-update': return this.chatLiveUpdate(userId, message);
      case 'give-answer-live-update': return this.giveAnswerLiveUpdate(userId, message);
      case 'toggle-controlled': return this.toggleControlled(userId, message);
      case 'toggle-lock': return this.toggleLock(userId, message);
      case 'toggle-login-required': return this.toggleLoginRequired(userId, message);
      case 'toggle-mute': return this.toggleMute(userId, message);
      case 'toggle-public': return this.togglePublic(userId, message);
      case 'votekick-init': return this.votekickInit(userId, message);
      case 'votekick-vote': return this.votekickVote(userId, message);
      default: super.message(userId, message);
    }
  }

  allowed (userId) {
    if (this.settings.public && !this.isPermanent) { return true; } // public rooms have iscontrolled disabled
    if ((userId === this.ownerId) || !this.settings.controlled) { return true; } else { return false; }
  }

  ban (userId, { targetId, targetUsername }) {
    console.log('Ban request received. Target ' + targetId);
    if (this.ownerId !== userId) { return; }

    this.emitMessage({ type: 'confirm-ban', targetId, targetUsername });
    this.bannedUserList.set(targetId, Date.now());
  }

  connection (socket, userId, username) {
    console.log(`Connection in room ${HEADER}${this.name}${ENDC} - ID of owner: ${OKBLUE}${this.ownerId}${ENDC} - userId: ${OKBLUE}${userId}${ENDC}, username: ${OKBLUE}${username}${ENDC} - with settings ${OKGREEN}${Object.keys(this.settings).map(key => [key, this.settings[key]].join(': ')).join('; ')};${ENDC}`);
    this.cleanupExpiredBansAndKicks();

    if (this.sockets[userId]) {
      this.sendToSocket(userId, { type: 'error', message: 'You joined in another tab' });
      this.close(userId);
    }

    const isNew = !(userId in this.players);
    if (isNew) { this.players[userId] = new ServerPlayer(userId); }
    this.players[userId].online = true;
    this.sockets[userId] = socket;
    username = this.players[userId].safelySetUsername(username);

    if (this.bannedUserList.has(userId)) {
      console.log(`Banned user ${userId} (${username}) tried to join a room`);
      this.sendToSocket(userId, { type: 'enforcing-removal', removalType: 'ban' });
      return;
    }

    if (this.kickedUserList.has(userId)) {
      console.log(`Kicked user ${userId} (${username}) tried to join a room`);
      this.sendToSocket(userId, { type: 'enforcing-removal', removalType: 'kick' });
      return;
    }

    socket.on('message', message => {
      if (this.rateLimiter(socket) && !this.rateLimitExceeded.has(username)) {
        console.log(`Rate limit exceeded for ${username} in room ${this.name}`);
        this.rateLimitExceeded.add(username);
        return;
      }

      try {
        message = JSON.parse(message);
      } catch (error) {
        console.log(`Error parsing message: ${message}`);
        return;
      }
      this.message(userId, message);
    });

    socket.on('close', this.close.bind(this, userId));

    socket.send(JSON.stringify({
      type: 'connection-acknowledged',
      userId,

      ownerId: this.ownerId,
      players: this.players,
      isPermanent: this.isPermanent,

      buzzedIn: this.buzzedIn,
      canBuzz: this.settings.rebuzz || !this.buzzes.includes(userId),
      mode: this.mode,
      questionProgress: this.tossupProgress,

      settings: this.settings
    }));

    socket.send(JSON.stringify({ type: 'connection-acknowledged-query', ...this.query, ...this.categoryManager.export() }));
    socket.send(JSON.stringify({ type: 'connection-acknowledged-tossup', tossup: this.tossup }));

    if (this.tossupProgress === TOSSUP_PROGRESS_ENUM.READING) {
      socket.send(JSON.stringify({
        type: 'update-question',
        word: this.questionSplit.slice(0, this.wordIndex).join(' ')
      }));
    }

    if (this.tossupProgress === TOSSUP_PROGRESS_ENUM.ANSWER_REVEALED && this.tossup?.answer) {
      socket.send(JSON.stringify({
        type: 'reveal-answer',
        question: insertTokensIntoHTML(this.tossup.question, this.tossup.question_sanitized, [this.buzzpointIndices], [' (#) ']),
        answer: this.tossup.answer
      }));
    }

    this.emitMessage({ type: 'join', isNew, userId, username, user: this.players[userId] });
  }

  chat (userId, { message }) {
    // prevent chat messages if room is public, since they can still be sent with API
    if (this.settings.public || typeof message !== 'string') { return false; }
    const username = this.players[userId].username;
    this.emitMessage({ type: 'chat', message, username, userId });
  }

  chatLiveUpdate (userId, { message }) {
    if (this.settings.public || typeof message !== 'string') { return false; }
    const username = this.players[userId].username;
    this.emitMessage({ type: 'chat-live-update', message, username, userId });
  }

  cleanupExpiredBansAndKicks () {
    const now = Date.now();

    this.bannedUserList.forEach((banTime, userId) => {
      if (now - banTime > BAN_DURATION) {
        this.bannedUserList.delete(userId);
      }
    });

    this.kickedUserList.forEach((kickTime, userId) => {
      if (now - kickTime > BAN_DURATION) {
        this.kickedUserList.delete(userId);
      }
    });
  }

  close (userId) {
    if (this.buzzedIn === userId) {
      this.giveAnswer(userId, this.liveAnswer);
      this.buzzedIn = null;
    }
    this.leave(userId);
  }

  giveAnswerLiveUpdate (userId, { message }) {
    if (typeof message !== 'string') { return false; }
    if (userId !== this.buzzedIn) { return false; }
    this.liveAnswer = message;
    const username = this.players[userId].username;
    this.emitMessage({ type: 'give-answer-live-update', message, username });
  }

  next (userId, { type }) {
    if (type === 'skip' && this.wordIndex < 3) { return false; } // prevents spam-skipping trolls
    super.next(userId, { type });
  }

  setCategories (userId, { categories, subcategories, alternateSubcategories, percentView, categoryPercents }) {
    if (this.isPermanent || !this.allowed(userId)) { return; }
    super.setCategories(userId, { categories, subcategories, alternateSubcategories, percentView, categoryPercents });
  }

  setMode (userId, { mode, setName }) {
    if (this.isPermanent || !this.allowed(userId)) { return; }
    if (!this.setList) { return; }
    if (!this.setList.includes(setName)) { return; }
    if (this.mode !== MODE_ENUM.SET_NAME && this.mode !== MODE_ENUM.RANDOM) { return; }
    super.setMode(userId, { mode, setName });
    this.adjustQuery(['setName'], [setName]);
  }

  setReadingSpeed (userId, { readingSpeed }) {
    if (this.isPermanent) { return; }
    super.setReadingSpeed(userId, { readingSpeed });
  }

  async setSetName (userId, { setName }) {
    if (!this.allowed(userId)) { return; }
    if (!this.setList) { return; }
    if (!this.setList.includes(setName)) { return; }
    super.setSetName(userId, { setName });
  }

  setStrictness (userId, { strictness }) {
    if (this.isPermanent || !this.allowed) { return; }
    super.setStrictness(userId, { strictness });
  }

  setUsername (userId, { username }) {
    if (typeof username !== 'string') { return false; }

    if (!isAppropriateString(username)) {
      this.sendToSocket(userId, {
        type: 'force-username',
        username: this.players[userId].username,
        message: 'Your username contains an inappropriate word, so it has been reverted.'
      });
      return;
    }

    const oldUsername = this.players[userId].username;
    const newUsername = this.players[userId].safelySetUsername(username);
    this.emitMessage({ type: 'set-username', userId, oldUsername, newUsername });
  }

  toggleControlled (userId, { controlled }) {
    if (this.settings.public) { return; }
    this.settings.controlled = !!controlled;
    const username = this.players[userId].username;
    this.emitMessage({ type: 'toggle-controlled', controlled, username });
  }

  toggleLock (userId, { lock }) {
    if (this.settings.public || !this.allowed(userId)) { return; }
    this.settings.lock = lock;
    const username = this.players[userId].username;
    this.emitMessage({ type: 'toggle-lock', lock, username });
  }

  toggleLoginRequired (userId, { loginRequired }) {
    if (this.settings.public || !this.allowed(userId)) { return; }
    this.settings.loginRequired = loginRequired;
    const username = this.players[userId].username;
    this.emitMessage({ type: 'toggle-login-required', loginRequired, username });
  }

  toggleMute (userId, { targetId, muteStatus }) {
    this.sendToSocket(userId, { type: 'mute-player', targetId, muteStatus });
  }

  togglePublic (userId, { public: isPublic }) {
    if (this.isPermanent || !this.allowed(userId)) { return; }
    this.settings.public = isPublic;
    this.settings.timer = true;
    const username = this.players[userId].username;
    if (isPublic) {
      this.settings.lock = false;
      this.settings.loginRequired = false;
    }
    this.emitMessage({ type: 'toggle-public', public: isPublic, username });
  }

  toggleTimer (userId, { timer }) {
    if (this.settings.public || !this.allowed(userId)) { return; }
    super.toggleTimer(userId, { timer });
  }

  votekickInit (userId, { targetId }) {
    if (!this.players[targetId]) { return; }
    const targetUsername = this.players[targetId].username;

    const currentTime = Date.now();
    if (this.lastVotekickTime[userId] && (currentTime - this.lastVotekickTime[userId] < 90000)) {
      return;
    }

    this.lastVotekickTime[userId] = currentTime;

    for (const votekick of this.votekickList) {
      if (votekick.exists(targetId)) { return; }
    }
    let activePlayers = 0;
    Object.keys(this.players).forEach(playerId => {
      if (this.players[playerId].online) {
        activePlayers += 1;
      }
    });

    const threshold = Math.max(Math.floor(activePlayers * 3 / 4), 2);
    const votekick = new Votekick(targetId, threshold, []);
    votekick.vote(userId);
    this.votekickList.push(votekick);
    if (votekick.check()) {
      this.emitMessage({ type: 'successful-vk', targetUsername, targetId });
      this.kickedUserList.set(targetId, Date.now());
    } else {
      this.kickedUserList.set(targetId, Date.now());
      this.emitMessage({ type: 'initiated-vk', targetUsername, threshold });
    }
  }

  votekickVote (userId, { targetId }) {
    if (!this.players[targetId]) { return; }
    const targetUsername = this.players[targetId].username;

    let exists = false;
    let thisVotekick;
    for (const votekick of this.votekickList) {
      if (votekick.exists(targetId)) {
        thisVotekick = votekick;
        exists = true;
      }
    }
    if (!exists) { return; }

    thisVotekick.vote(userId);
    if (thisVotekick.check()) {
      this.emitMessage({ type: 'successful-vk', targetUsername, targetId });
      this.kickedUserList.set(targetId, Date.now());

      if (targetId === this.ownerId) {
        const onlinePlayers = Object.keys(this.players).filter(playerId => this.players[playerId].online);
        const newHost = onlinePlayers.reduce((maxPlayer, playerId) => (this.players[playerId].tuh || 0) > (this.players[maxPlayer].tuh || 0) ? playerId : maxPlayer, onlinePlayers[0]);
        // ^^ highest tuh player becomes new host

        this.ownerId = newHost;

        this.emitMessage({ type: 'owner-change', newOwner: newHost });
      }
    }
  }
}
