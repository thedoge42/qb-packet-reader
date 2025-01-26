import questionStats from '../scripts/auth/question-stats.js';
import api from '../scripts/api/index.js';
import audio from '../audio/index.js';
import CategoryManager from '../../quizbowl/category-manager.js';
import { getDropdownValues } from '../scripts/utilities/dropdown-checklist.js';
import { arrayToRange, createTossupCard, rangeToArray } from '../scripts/utilities/index.js';
import CategoryModal from '../scripts/components/CategoryModal.min.js';
import DifficultyDropdown from '../scripts/components/DifficultyDropdown.min.js';
import upsertPlayerItem from '../scripts/upsertPlayerItem.js';
import { MODE_ENUM } from '../../quizbowl/constants.js';

const categoryManager = new CategoryManager();
let oldCategories = JSON.stringify(categoryManager.export());
let startingDifficulties = [];
let ownerId = '';
let maxPacketNumber = 24;
let globalPublic = true;
let muteList = [];
const isPermanent = false;
/**
 * userId to player object
 */
const players = {};

const ROOM_NAME = decodeURIComponent(window.location.pathname.substring(13));
let tossup = {};
let USER_ID = window.localStorage.getItem('USER_ID') || 'unknown';
let username = window.localStorage.getItem('multiplayer-username') || api.getRandomName();

const socket = new window.WebSocket(
  window.location.href.replace('http', 'ws').split('?')[0] + '?' +
    new URLSearchParams({
      ...new URLSearchParams(window.location.search),
      roomName: ROOM_NAME,
      userId: USER_ID,
      username
    }).toString()
);

// Ping server every 45 seconds to prevent socket disconnection
const PING_INTERVAL_ID = setInterval(
  () => socket.send(JSON.stringify({ type: 'ping' })),
  45000
);

socket.onclose = function (event) {
  const { code } = event;
  if (code !== 3000) { window.alert('Disconnected from server'); }
  clearInterval(PING_INTERVAL_ID);
};

socket.onmessage = function (event) {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case 'buzz': return buzz(data);
    case 'chat': return chat(data, false);
    case 'chat-live-update': return chat(data, true);
    case 'clear-stats': return clearStats(data);
    case 'confirm-ban': return confirmBan(data);
    case 'connection-acknowledged': return connectionAcknowledged(data);
    case 'connection-acknowledged-query': return connectionAcknowledgedQuery(data);
    case 'connection-acknowledged-tossup': return connectionAcknowledgedTossup(data);
    case 'enforcing-removal': return ackRemovedFromRoom(data);
    case 'end': return next(data);
    case 'end-of-set': return endOfSet(data);
    case 'error': return handleError(data);
    case 'force-username': return forceUsername(data);
    case 'give-answer': return giveAnswer(data);
    case 'give-answer-live-update': return logGiveAnswer(data, true);
    case 'initiated-vk': return vkInit(data);
    case 'join': return join(data);
    case 'leave': return leave(data);
    case 'lost-buzzer-race': return lostBuzzerRace(data);
    case 'mute-player': return mutePlayer(data);
    case 'next': return next(data);
    case 'no-questions-found': return noQuestionsFound(data);
    case 'owner-change': return ownerChange(data);
    case 'pause': return pause(data);
    case 'reveal-answer': return revealAnswer(data);
    case 'set-categories': return setCategories(data);
    case 'set-difficulties': return setDifficulties(data);
    case 'set-mode': return setMode(data);
    case 'set-packet-numbers': return setPacketNumbers(data);
    case 'set-reading-speed': return setReadingSpeed(data);
    case 'set-set-name': return setSetName(data);
    case 'set-strictness': return setStrictness(data);
    case 'set-username': return setUsername(data);
    case 'set-year-range': return setYearRange(data);
    case 'skip': return next(data);
    case 'start': return next(data);
    case 'successful-vk': return vkHandle(data);
    case 'timer-update': return updateTimerDisplay(data.timeRemaining);
    case 'toggle-controlled': return toggleControlled(data);
    case 'toggle-lock': return toggleLock(data);
    case 'toggle-login-required': return toggleLoginRequired(data);
    case 'toggle-powermark-only': return togglePowermarkOnly(data);
    case 'toggle-public': return togglePublic(data);
    case 'toggle-rebuzz': return toggleRebuzz(data);
    case 'toggle-skip': return toggleSkip(data);
    case 'toggle-standard-only': return toggleStandardOnly(data);
    case 'toggle-timer': return toggleTimer(data);
    case 'update-question': return updateQuestion(data);
  }
};
// if a banned/kicked user tries to join a room they were removed from this is the response
function ackRemovedFromRoom ({ removalType }) {
  if (removalType === 'kick') {
    window.alert('You were kicked from this room by players, and cannot rejoin it.');
  } else {
    window.alert('You were banned from this room by the room owner, and cannot rejoin it.');
  }
  setTimeout(() => {
    window.location.replace('../');
  }, 100);
}

function buzz ({ userId, username }) {
  logEvent(username, 'buzzed');
  document.getElementById('buzz').disabled = true;
  document.getElementById('pause').disabled = true;
  document.getElementById('next').disabled = true;
  document.getElementById('skip').disabled = true;

  if (userId === USER_ID) {
    document.getElementById('answer-input-group').classList.remove('d-none');
    document.getElementById('answer-input').focus();
  }
}

function chat ({ message, userId, username }, live = false) {
  if (muteList.includes(userId)) {
    return;
  }
  if (!live && message === '') {
    document.getElementById('live-chat-' + userId).parentElement.remove();
    return;
  }

  if (!live && message) {
    document.getElementById('live-chat-' + userId).className = '';
    document.getElementById('live-chat-' + userId).id = '';
    return;
  }

  if (document.getElementById('live-chat-' + userId)) {
    document.getElementById('live-chat-' + userId).textContent = message;
    return;
  }

  const b = document.createElement('b');
  b.textContent = username;

  const span = document.createElement('span');
  span.classList.add('text-muted');
  span.id = 'live-chat-' + userId;
  span.textContent = message;

  const li = document.createElement('li');
  li.appendChild(b);
  li.appendChild(document.createTextNode(' '));
  li.appendChild(span);
  document.getElementById('room-history').prepend(li);
}

function clearStats ({ userId }) {
  for (const field of ['celerity', 'negs', 'points', 'powers', 'tens', 'tuh', 'zeroes']) {
    players[userId][field] = 0;
  }
  upsertPlayerItem(players[userId], USER_ID, ownerId, socket, globalPublic);
  sortPlayerListGroup();
}

function confirmBan ({ targetId, targetUsername }) {
  if (targetId === USER_ID) {
    window.alert('You were banned from this room by the room owner.');
    setTimeout(() => {
      window.location.replace('../');
    }, 100);
  } else {
    logEvent(targetUsername + ' has been banned from this room.');
  }
}

function connectionAcknowledged ({
  buzzedIn,
  canBuzz,
  isPermanent,
  ownerId: serverOwnerId,
  mode,
  players: messagePlayers,
  questionProgress,
  settings,
  userId
}) {
  document.getElementById('buzz').disabled = !canBuzz;

  if (isPermanent) {
    isPermanent = true;

    document.getElementById('category-select-button').disabled = true;
    document.getElementById('reading-speed').disabled = true;
    document.getElementById('set-strictness').disabled = true;
    document.getElementById('set-mode').disabled = true;
    document.getElementById('toggle-public').disabled = true;
    document.getElementById('private-chat-warning').innerHTML = 'This is a permanent room. Some settings have been restricted.';
  }

  ownerId = serverOwnerId;
  for (const userId of Object.keys(messagePlayers)) {
    messagePlayers[userId].celerity = messagePlayers[userId].celerity.correct.average;
    players[userId] = messagePlayers[userId];
    upsertPlayerItem(players[userId], USER_ID, ownerId, socket, globalPublic);
  }
  sortPlayerListGroup();

  setMode({ mode });

  switch (questionProgress) {
    case 0:
      document.getElementById('next').textContent = 'Start';
      document.getElementById('next').classList.remove('btn-primary');
      document.getElementById('next').classList.add('btn-success');
      break;
    case 1:
      showSkipButton();
      document.getElementById('settings').classList.add('d-none');
      if (buzzedIn) {
        document.getElementById('buzz').disabled = true;
        document.getElementById('next').disabled = true;
        document.getElementById('pause').disabled = true;
      } else {
        document.getElementById('buzz').disabled = false;
        document.getElementById('pause').disabled = false;
      }
      break;
    case 2:
      showNextButton();
      document.getElementById('settings').classList.add('d-none');
      break;
  }

  document.getElementById('toggle-lock').checked = settings.lock;

  document.getElementById('toggle-login-required').checked = settings.loginRequired;

  document.getElementById('chat').disabled = settings.public;
  document.getElementById('toggle-lock').disabled = settings.public;
  document.getElementById('toggle-login-required').disabled = settings.public;
  document.getElementById('toggle-timer').disabled = settings.public;
  document.getElementById('toggle-public').checked = settings.public;
  globalPublic = settings.public;

  document.getElementById('reading-speed').value = settings.readingSpeed;
  document.getElementById('reading-speed-display').textContent = settings.readingSpeed;
  document.getElementById('set-strictness').value = settings.strictness;
  document.getElementById('strictness-display').textContent = settings.strictness;

  document.getElementById('toggle-rebuzz').checked = settings.rebuzz;

  document.getElementById('toggle-skip').checked = settings.skip;

  document.getElementById('timer').classList.toggle('d-none', !settings.timer);
  document.getElementById('toggle-timer').checked = settings.timer;

  USER_ID = userId;
  window.localStorage.setItem('USER_ID', USER_ID);
}

async function connectionAcknowledgedQuery ({
  difficulties = [],
  minYear,
  maxYear,
  packetNumbers = [],
  powermarkOnly,
  setName = '',
  standardOnly,
  alternateSubcategories,
  categories,
  subcategories,
  percentView,
  categoryPercents
}) {
  setDifficulties({ difficulties });

  document.getElementById('year-range-a').textContent = minYear;
  document.getElementById('year-range-b').textContent = maxYear;

  document.getElementById('packet-number').value = arrayToRange(packetNumbers);

  document.getElementById('toggle-powermark-only').checked = powermarkOnly;

  document.getElementById('set-name').value = setName;
  maxPacketNumber = await api.getNumPackets(setName);
  if (setName !== '' && maxPacketNumber === 0) {
    document.getElementById('set-name').classList.add('is-invalid');
  }

  document.getElementById('toggle-standard-only').checked = standardOnly;

  categoryManager.import({ categories, subcategories, alternateSubcategories, percentView, categoryPercents });
  categoryManager.loadCategoryModal();

  $(document).ready(function () {
    $('#slider').slider('values', 0, minYear);
    $('#slider').slider('values', 1, maxYear);
  });
}

function connectionAcknowledgedTossup ({ tossup: currentTossup }) {
  tossup = currentTossup;
  document.getElementById('set-name-info').textContent = tossup?.set?.name ?? '';
  document.getElementById('packet-number-info').textContent = tossup?.packet?.number ?? '-';
  document.getElementById('question-number-info').textContent = tossup?.number ?? '-';
}

function endOfSet () {
  window.alert('You have reached the end of the set');
}

function forceUsername ({ message, username }) {
  window.alert(message);
  window.localStorage.setItem('multiplayer-username', username);
  document.querySelector('#username').value = username;
}

async function giveAnswer ({ celerity, directive, directedPrompt, givenAnswer, perQuestionCelerity, score, tossup, userId, username }) {
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-input-group').classList.add('d-none');
  document.getElementById('answer-input').blur();
  logGiveAnswer({ directive, message: givenAnswer, username });

  if (directive === 'prompt' && directedPrompt) {
    logEvent(username, `was prompted with "${directedPrompt}"`);
  } else if (directive === 'prompt') {
    logEvent(username, 'was prompted');
  } else {
    logEvent(username, `${score > 0 ? '' : 'in'}correctly answered for ${score} points`);
  }

  if (directive === 'prompt' && userId === USER_ID) {
    document.getElementById('answer-input-group').classList.remove('d-none');
    document.getElementById('answer-input').focus();
    document.getElementById('answer-input').placeholder = directedPrompt ? `Prompt: "${directedPrompt}"` : 'Prompt';
  } else if (directive !== 'prompt') {
    document.getElementById('answer-input').placeholder = 'Enter answer';
    document.getElementById('next').disabled = false;
    document.getElementById('pause').disabled = false;

    if (directive === 'accept') {
      document.getElementById('buzz').disabled = true;
      Array.from(document.getElementsByClassName('tuh')).forEach(element => {
        element.textContent = parseInt(element.innerHTML) + 1;
      });
    }

    if (directive === 'reject') {
      document.getElementById('buzz').disabled = !document.getElementById('toggle-rebuzz').checked && userId === USER_ID;
    }

    if (score > 10) {
      players[userId].powers++;
    } else if (score === 10) {
      players[userId].tens++;
    } else if (score < 0) {
      players[userId].negs++;
    }

    players[userId].points += score;
    players[userId].tuh++;
    players[userId].celerity = celerity;

    upsertPlayerItem(players[userId], USER_ID, ownerId, socket, globalPublic);
    sortPlayerListGroup();
  }

  if (directive !== 'prompt' && userId === USER_ID) {
    questionStats.recordTossup(tossup, score > 0, score, perQuestionCelerity, true);
  }

  if (audio.soundEffects && userId === USER_ID) {
    if (directive === 'accept' && score > 10) {
      audio.power.play();
    } else if (directive === 'accept' && score === 10) {
      audio.correct.play();
    } else if (directive === 'reject') {
      audio.incorrect.play();
    }
  }
}

function handleError ({ message }) {
  socket.close(3000);
  window.alert(message);
  window.location.href = '/multiplayer';
}

function join ({ isNew, user, userId, username }) {
  logEvent(username, 'joined the game');
  if (userId === USER_ID) { return; }

  if (isNew) {
    user.celerity = user.celerity.correct.average;
    upsertPlayerItem(user, USER_ID, ownerId, socket, globalPublic);
    sortPlayerListGroup();
    players[userId] = user;
  } else {
    players[userId].online = true;
    document.getElementById('points-' + userId).classList.add('bg-success');
    document.getElementById('points-' + userId).classList.remove('bg-secondary');
  }
}

function leave ({ userId, username }) {
  logEvent(username, 'left the game');
  players[userId].online = false;
  document.getElementById('points-' + userId).classList.remove('bg-success');
  document.getElementById('points-' + userId).classList.add('bg-secondary');
}

function logEvent (username, message) {
  const span1 = document.createElement('span');
  span1.textContent = username;

  const span2 = document.createElement('span');
  span2.textContent = message;

  const i = document.createElement('i');
  i.appendChild(span1);
  i.appendChild(document.createTextNode(' '));
  i.appendChild(span2);

  const li = document.createElement('li');
  li.appendChild(i);

  document.getElementById('room-history').prepend(li);
}

function logGiveAnswer ({ directive = null, message, username }) {
  const badge = document.createElement('span');
  badge.textContent = 'Buzz';
  switch (directive) {
    case 'accept':
      badge.className = 'badge text-dark bg-success';
      break;
    case 'reject':
      badge.className = 'badge text-light bg-danger';
      break;
    case 'prompt':
      badge.className = 'badge text-dark bg-warning';
      break;
    default:
      badge.className = 'badge text-light bg-primary';
      break;
  }

  const b = document.createElement('b');
  b.textContent = username;

  const span = document.createElement('span');
  span.textContent = message;

  let li;
  if (document.getElementById('live-buzz')) {
    li = document.getElementById('live-buzz');
    li.textContent = '';
  } else {
    li = document.createElement('li');
    li.id = 'live-buzz';
    document.getElementById('room-history').prepend(li);
  }

  li.appendChild(badge);
  li.appendChild(document.createTextNode(' '));
  li.appendChild(b);
  li.appendChild(document.createTextNode(' '));
  li.appendChild(span);

  if (directive === 'accept' || directive === 'reject') {
    const secondBadge = document.createElement('span');
    secondBadge.className = badge.className;

    if (directive === 'accept') {
      secondBadge.textContent = 'Correct';
    } else if (directive === 'reject') {
      secondBadge.textContent = 'Incorrect';
    }

    li.appendChild(document.createTextNode(' '));
    li.appendChild(secondBadge);
  }

  if (directive) { li.id = ''; }
}

function lostBuzzerRace ({ username, userId }) {
  logEvent(username, 'lost the buzzer race');
  if (userId === USER_ID) { document.getElementById('answer-input-group').classList.add('d-none'); }
}
function mutePlayer ({ targetId, muteStatus }) {
  if (muteStatus === 'Mute') {
    if (!muteList.includes(targetId)) {
      muteList.push(targetId);
    }
  } else {
    if (muteList.includes(targetId)) {
      muteList = muteList.filter(Id => Id !== targetId);
    }
  }
}

function next ({ oldTossup, tossup: nextTossup, type, username }) {
  const typeStrings = {
    end: 'ended the game',
    next: 'went to the next question',
    skip: 'skipped the question',
    start: 'started the game'
  };
  logEvent(username, typeStrings[type]);

  if (type === 'start') {
    document.getElementById('next').classList.add('btn-primary');
    document.getElementById('next').classList.remove('btn-success');
    document.getElementById('next').textContent = 'Next';
  }

  if (type !== 'start') {
    createTossupCard(oldTossup);
  }

  document.getElementById('answer').textContent = '';
  document.getElementById('question').textContent = '';
  document.getElementById('settings').classList.add('d-none');

  if (type === 'end') {
    document.getElementById('buzz').disabled = true;
    document.getElementById('next').classList.remove('btn-primary');
    document.getElementById('next').classList.add('btn-success');
    document.getElementById('next').textContent = 'Start';
  } else {
    tossup = nextTossup;
    document.getElementById('buzz').textContent = 'Buzz';
    document.getElementById('buzz').disabled = false;
    document.getElementById('packet-number-info').textContent = tossup?.packet.number ?? '-';
    document.getElementById('pause').textContent = 'Pause';
    document.getElementById('pause').disabled = false;
    document.getElementById('question-number-info').textContent = tossup?.number ?? '-';
    document.getElementById('set-name-info').textContent = tossup?.set.name ?? '';
  }

  showSkipButton();
  updateTimerDisplay(100);
}

function noQuestionsFound () {
  window.alert('No questions found');
}

function ownerChange ({ newOwner }) {
  if (players[newOwner]) {
    ownerId = newOwner;
    logEvent(players[newOwner].username, 'became the room owner');
  } else logEvent(newOwner, 'became the room owner');

  Object.keys(players).forEach((player) => {
    upsertPlayerItem(players[player], USER_ID, ownerId, socket, globalPublic);
  });
}

function pause ({ paused, username }) {
  logEvent(username, `${paused ? '' : 'un'}paused the game`);
  document.getElementById('pause').textContent = paused ? 'Resume' : 'Pause';
}

function revealAnswer ({ answer, question }) {
  document.getElementById('question').innerHTML = question;
  document.getElementById('answer').innerHTML = 'ANSWER: ' + answer;
  document.getElementById('pause').disabled = true;
  showNextButton();
}

function setCategories ({ alternateSubcategories, categories, subcategories, percentView, categoryPercents, username }) {
  logEvent(username, 'updated the categories');
  categoryManager.import({ categories, subcategories, alternateSubcategories, percentView, categoryPercents });
  categoryManager.loadCategoryModal();
}

function setDifficulties ({ difficulties, username = undefined }) {
  if (username) { logEvent(username, difficulties.length > 0 ? `set the difficulties to ${difficulties}` : 'cleared the difficulties'); }

  if (!document.getElementById('difficulties')) {
    startingDifficulties = difficulties;
    return;
  }

  Array.from(document.getElementById('difficulties').children).forEach(li => {
    const input = li.querySelector('input');
    if (difficulties.includes(parseInt(input.value))) {
      input.checked = true;
      li.classList.add('active');
    } else {
      input.checked = false;
      li.classList.remove('active');
    }
  });
}

function setMode ({ mode, setName, username }) {
  if (username) {
    logEvent(username, 'changed the mode to ' + mode);
  }

  switch (mode) {
    case MODE_ENUM.SET_NAME:
      document.getElementById('difficulty-settings').classList.add('d-none');
      document.getElementById('set-name').textContent = setName;
      document.getElementById('set-settings').classList.remove('d-none');
      document.getElementById('toggle-powermark-only').disabled = true;
      document.getElementById('toggle-standard-only').disabled = true;
      break;
    case MODE_ENUM.RANDOM:
      document.getElementById('difficulty-settings').classList.remove('d-none');
      document.getElementById('set-settings').classList.add('d-none');
      document.getElementById('toggle-powermark-only').disabled = false;
      document.getElementById('toggle-standard-only').disabled = false;
      break;
  }
  document.getElementById('set-mode').value = mode;
}

function setPacketNumbers ({ username, packetNumbers }) {
  packetNumbers = arrayToRange(packetNumbers);
  logEvent(username, packetNumbers.length > 0 ? `changed packet numbers to ${packetNumbers}` : 'cleared packet numbers');
  document.getElementById('packet-number').value = packetNumbers;
}

function setReadingSpeed ({ username, readingSpeed }) {
  logEvent(username, `changed the reading speed to ${readingSpeed}`);
  document.getElementById('reading-speed').value = readingSpeed;
  document.getElementById('reading-speed-display').textContent = readingSpeed;
}

function setStrictness ({ strictness, username }) {
  logEvent(username, `changed the strictness to ${strictness}`);
  document.getElementById('set-strictness').value = strictness;
  document.getElementById('strictness-display').textContent = strictness;
}

function setSetName ({ username, setName, setLength }) {
  logEvent(username, setName.length > 0 ? `changed set name to ${setName}` : 'cleared set name');
  document.getElementById('set-name').value = setName;
  // make border red if set name is not in set list
  const valid = !setName || api.getSetList().includes(setName);
  document.getElementById('set-name').classList.toggle('is-invalid', !valid);
  maxPacketNumber = setLength;
  document.getElementById('packet-number').placeholder = 'Packet Numbers' + (maxPacketNumber ? ` (1-${maxPacketNumber})` : '');
}

function setUsername ({ oldUsername, newUsername, userId }) {
  logEvent(oldUsername, `changed their username to ${newUsername}`);
  document.getElementById('username-' + userId).textContent = newUsername;
  players[userId].username = newUsername;
  sortPlayerListGroup();

  if (userId === USER_ID) {
    username = newUsername;
    window.localStorage.setItem('multiplayer-username', username);
    document.getElementById('username').value = username;
  }
  upsertPlayerItem(players[userId], USER_ID, ownerId, socket, globalPublic);
}

function setYearRange ({ minYear, maxYear, username }) {
  if (username) { logEvent(username, `changed the year range to ${minYear}-${maxYear}`); }

  $('#slider').slider('values', 0, minYear);
  $('#slider').slider('values', 1, maxYear);
  document.getElementById('year-range-a').textContent = minYear;
  document.getElementById('year-range-b').textContent = maxYear;
}

function showNextButton () {
  document.getElementById('next').classList.remove('d-none');
  document.getElementById('next').disabled = false;
  document.getElementById('skip').classList.add('d-none');
  document.getElementById('skip').disabled = true;
}

function showSkipButton () {
  document.getElementById('skip').classList.remove('d-none');
  document.getElementById('skip').disabled = !document.getElementById('toggle-skip').checked;
  document.getElementById('next').classList.add('d-none');
  document.getElementById('next').disabled = true;
}

function sortPlayerListGroup (descending = true) {
  const listGroup = document.getElementById('player-list-group');
  const items = Array.from(listGroup.children);
  const offset = 'list-group-'.length;
  items.sort((a, b) => {
    const aPoints = parseInt(document.getElementById('points-' + a.id.substring(offset)).innerHTML);
    const bPoints = parseInt(document.getElementById('points-' + b.id.substring(offset)).innerHTML);
    // if points are equal, sort alphabetically by username
    if (aPoints === bPoints) {
      const aUsername = document.getElementById('username-' + a.id.substring(offset)).innerHTML;
      const bUsername = document.getElementById('username-' + b.id.substring(offset)).innerHTML;
      return descending ? aUsername.localeCompare(bUsername) : bUsername.localeCompare(aUsername);
    }
    return descending ? bPoints - aPoints : aPoints - bPoints;
  }).forEach(item => {
    listGroup.appendChild(item);
  });
}

function processControlled (yesNo) {
  document.getElementById('toggle-controlled').checked = yesNo;

  document.getElementById('toggle-lock').disabled = yesNo;
  document.getElementById('toggle-login-required').disabled = yesNo;
  document.getElementById('toggle-timer').disabled = yesNo;
  document.getElementById('toggle-powermark-only').disabled = yesNo;
  document.getElementById('toggle-public').disabled = yesNo;
  document.getElementById('toggle-rebuzz').disabled = yesNo;

  document.getElementById('category-select-button').disabled = yesNo;
  document.getElementById('reading-speed').disabled = yesNo;
  document.getElementById('set-mode').disabled = yesNo;
  document.getElementById('set-strictness').disabled = yesNo;

  if (!isPermanent && yesNo) document.getElementById('private-chat-warning').innerHTML = 'This is a controlled room. Some settings can only be edited by the creator.';
  else if (!isPermanent) document.getElementById('private-chat-warning').innerHTML = '';
}

function toggleControlled ({ controlled, username }) {
  logEvent(username, `${controlled ? 'enabled' : 'disabled'} controlled mode`);

  document.getElementById('toggle-controlled').disabled = (globalPublic === false || isPermanent) && ownerId !== USER_ID;

  if (controlled && (globalPublic === false || isPermanent) && ownerId !== USER_ID) processControlled(true);
  else processControlled(false);
}

function toggleLock ({ lock, username }) {
  logEvent(username, `${lock ? 'locked' : 'unlocked'} the room`);
  document.getElementById('toggle-lock').checked = lock;
}

function toggleLoginRequired ({ loginRequired, username }) {
  logEvent(username, `${loginRequired ? 'enabled' : 'disabled'} require players to be logged in`);
  document.getElementById('toggle-login-required').checked = loginRequired;
}

function togglePowermarkOnly ({ powermarkOnly, username }) {
  logEvent(username, `${powermarkOnly ? 'enabled' : 'disabled'} powermark only`);
  document.getElementById('toggle-powermark-only').checked = powermarkOnly;
}

function toggleRebuzz ({ rebuzz, username }) {
  logEvent(username, `${rebuzz ? 'enabled' : 'disabled'} multiple buzzes (effective next question)`);
  document.getElementById('toggle-rebuzz').checked = rebuzz;
}

function toggleSkip ({ skip, username }) {
  logEvent(username, `${skip ? 'enabled' : 'disabled'} skipping`);
  document.getElementById('toggle-skip').checked = skip;
  document.getElementById('skip').disabled = !skip || document.getElementById('skip').classList.contains('d-none');
}

function toggleStandardOnly ({ standardOnly, username }) {
  logEvent(username, `${standardOnly ? 'enabled' : 'disabled'} standard format only`);
  document.getElementById('toggle-standard-only').checked = standardOnly;
}

function toggleTimer ({ timer, username }) {
  logEvent(username, `${timer ? 'enabled' : 'disabled'} the timer`);
  document.getElementById('toggle-timer').checked = timer;
  document.getElementById('timer').classList.toggle('d-none');
}

function togglePublic ({ public: isPublic, username }) {
  logEvent(username, `made the room ${isPublic ? 'public' : 'private'}`);
  document.getElementById('chat').disabled = isPublic;
  document.getElementById('toggle-lock').disabled = isPublic;
  document.getElementById('toggle-login-required').disabled = isPublic;
  document.getElementById('toggle-timer').disabled = isPublic;
  document.getElementById('toggle-timer').checked = true;
  document.getElementById('toggle-public').checked = isPublic;
  globalPublic = isPublic;
  if (isPublic) {
    document.getElementById('toggle-lock').checked = false;
    document.getElementById('toggle-login-required').checked = false;
  }
  Object.keys(players).forEach((player) => {
    upsertPlayerItem(players[player], USER_ID, ownerId, socket, globalPublic);
  });
}

function updateQuestion ({ word }) {
  if (word === '(*)' || word === '[*]') { return; }
  document.getElementById('question').innerHTML += word + ' ';
}

function updateTimerDisplay (time) {
  const seconds = Math.floor(time / 10);
  const tenths = time % 10;

  document.querySelector('.timer .face').textContent = seconds;
  document.querySelector('.timer .fraction').textContent = '.' + tenths;
}

function vkInit ({ targetUsername, threshold }) {
  logEvent(`A votekick has been started against user ${targetUsername} and needs ${threshold} votes to succeed.`);
}

function vkHandle ({ targetUsername, targetId }) {
  if (USER_ID === targetId) {
    window.alert('You were vote kicked from this room by others.');
    setTimeout(() => {
      window.location.replace('../');
    }, 100);
  } else {
    logEvent(targetUsername + ' has been vote kicked from this room.');
  }
}

document.getElementById('answer-form').addEventListener('submit', function (event) {
  event.preventDefault();
  event.stopPropagation();

  const answer = document.getElementById('answer-input').value;
  socket.send(JSON.stringify({ type: 'give-answer', givenAnswer: answer }));
});

document.getElementById('answer-input').addEventListener('input', function () {
  socket.send(JSON.stringify({ type: 'give-answer-live-update', message: this.value }));
});

document.getElementById('buzz').addEventListener('click', function () {
  this.blur();
  if (audio.soundEffects) audio.buzz.play();
  socket.send(JSON.stringify({ type: 'buzz' }));
  socket.send(JSON.stringify({ type: 'give-answer-live-update', message: '' }));
});

document.getElementById('chat').addEventListener('click', function () {
  this.blur();
  document.getElementById('chat-input-group').classList.remove('d-none');
  document.getElementById('chat-input').focus();
  socket.send(JSON.stringify({ type: 'chat-live-update', message: '' }));
});

document.getElementById('chat-form').addEventListener('submit', function (event) {
  event.preventDefault();
  event.stopPropagation();

  const message = document.getElementById('chat-input').value;
  document.getElementById('chat-input').value = '';
  document.getElementById('chat-input-group').classList.add('d-none');
  document.getElementById('chat-input').blur();

  socket.send(JSON.stringify({ type: 'chat', message }));
});

document.getElementById('chat-input').addEventListener('input', function () {
  socket.send(JSON.stringify({ type: 'chat-live-update', message: this.value }));
});

document.getElementById('clear-stats').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'clear-stats' }));
});

document.getElementById('next').addEventListener('click', function () {
  this.blur();
  switch (this.innerHTML) {
    case 'Start':
      socket.send(JSON.stringify({ type: 'start' }));
      break;
    case 'Next':
      socket.send(JSON.stringify({ type: 'next' }));
      break;
  }
});

document.getElementById('skip').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'skip' }));
});

document.getElementById('packet-number').addEventListener('change', function () {
  const range = rangeToArray(this.value, maxPacketNumber);
  if (range.some((num) => num < 1 || num > maxPacketNumber)) {
    document.getElementById('packet-number').classList.add('is-invalid');
    return;
  }

  document.getElementById('packet-number').classList.remove('is-invalid');
  socket.send(JSON.stringify({ type: 'set-packet-numbers', packetNumbers: range }));
});

document.getElementById('pause').addEventListener('click', function () {
  this.blur();
  const seconds = parseFloat(document.querySelector('.timer .face').textContent);
  const tenths = parseFloat(document.querySelector('.timer .fraction').textContent);
  const pausedTime = (seconds + tenths) * 10;
  socket.send(JSON.stringify({ type: 'pause', pausedTime }));
});

document.getElementById('reading-speed').addEventListener('change', function () {
  socket.send(JSON.stringify({ type: 'set-reading-speed', readingSpeed: this.value }));
});

document.getElementById('reading-speed').addEventListener('input', function () {
  document.getElementById('reading-speed-display').textContent = this.value;
});

document.getElementById('report-question-submit').addEventListener('click', function () {
  api.reportQuestion(
    document.getElementById('report-question-id').value,
    document.getElementById('report-question-reason').value,
    document.getElementById('report-question-description').value
  );
});

document.getElementById('set-name').addEventListener('change', async function () {
  socket.send(JSON.stringify({ type: 'set-set-name', setName: this.value }));
});

document.getElementById('set-strictness').addEventListener('change', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'set-strictness', strictness: this.value }));
});

document.getElementById('set-strictness').addEventListener('input', function () {
  document.getElementById('strictness-display').textContent = this.value;
});

document.getElementById('toggle-controlled').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-controlled', controlled: this.checked }));
});

document.getElementById('toggle-lock').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-lock', lock: this.checked }));
});

document.getElementById('toggle-login-required').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-login-required', loginRequired: this.checked }));
});

document.getElementById('toggle-powermark-only').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-powermark-only', powermarkOnly: this.checked }));
});

document.getElementById('toggle-rebuzz').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-rebuzz', rebuzz: this.checked }));
});

document.getElementById('toggle-skip').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-skip', skip: this.checked }));
});

document.getElementById('set-mode').addEventListener('change', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'set-mode', setName: document.getElementById('set-name').value, mode: this.value }));
});

document.getElementById('toggle-settings').addEventListener('click', function () {
  this.blur();
  document.getElementById('buttons').classList.toggle('col-lg-9');
  document.getElementById('buttons').classList.toggle('col-lg-12');
  document.getElementById('content').classList.toggle('col-lg-9');
  document.getElementById('content').classList.toggle('col-lg-12');
  document.getElementById('settings').classList.toggle('d-none');
  document.getElementById('settings').classList.toggle('d-lg-none');
});

document.getElementById('toggle-standard-only').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-standard-only', standardOnly: this.checked }));
});

document.getElementById('toggle-timer').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-timer', timer: this.checked }));
});

document.getElementById('toggle-public').addEventListener('click', function () {
  this.blur();
  socket.send(JSON.stringify({ type: 'toggle-public', public: this.checked }));
});

document.getElementById('username').addEventListener('change', function () {
  socket.send(JSON.stringify({ type: 'set-username', userId: USER_ID, username: this.value }));
  username = this.value;
  window.localStorage.setItem('multiplayer-username', username);
});

document.getElementById('year-range-a').onchange = function () {
  const [minYear, maxYear] = $('#slider').slider('values');
  if (maxYear < minYear) {
    document.querySelector('#yearRangeAlert').style.display = '';
    return;
  } else {
    document.querySelector('#yearRangeAlert').style.display = 'none';
  }
  socket.send(JSON.stringify({ type: 'set-year-range', minYear, maxYear }));
};

document.addEventListener('keydown', (event) => {
  // press escape to close chat
  if (event.key === 'Escape' && document.activeElement.id === 'chat-input') {
    document.getElementById('chat-input').value = '';
    document.getElementById('chat-input-group').classList.add('d-none');
    document.getElementById('chat-input').blur();
    socket.send(JSON.stringify({ type: 'chat', message: '' }));
  }

  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

  switch (event.key?.toLowerCase()) {
    case ' ':
      document.getElementById('buzz').click();
      // Prevent spacebar from scrolling the page
      if (event.target === document.body) { event.preventDefault(); }
      break;

    case 'e': return document.getElementById('toggle-settings').click();
    case 'k': return document.getElementsByClassName('card-header-clickable')[0].click();
    case 'p': return document.getElementById('pause').click();
    case 't': return document.getElementsByClassName('star-tossup')[0].click();
    case 'y': return navigator.clipboard.writeText(tossup._id ?? '');

    case 'n':
    case 's':
      document.getElementById('next').click();
      document.getElementById('skip').click();
      break;
  }
});

document.addEventListener('keypress', function (event) {
  // needs to be keypress
  // keydown immediately hides the input group
  // keyup shows the input group again after submission
  if (event.key === 'Enter' && event.target === document.body) {
    document.getElementById('chat').click();
  }
});

document.getElementById('username').value = username;

ReactDOM.createRoot(document.getElementById('category-modal-root')).render(
  <CategoryModal
    categoryManager={categoryManager}
    onClose={() => {
      if (oldCategories !== JSON.stringify(categoryManager.export())) {
        socket.send(JSON.stringify({ type: 'set-categories', ...categoryManager.export() }));
      }
      oldCategories = JSON.stringify(categoryManager.export());
    }}
  />
);

ReactDOM.createRoot(document.getElementById('difficulty-dropdown-root')).render(
  <DifficultyDropdown
    startingDifficulties={startingDifficulties}
    onChange={() => socket.send(JSON.stringify({ type: 'set-difficulties', difficulties: getDropdownValues('difficulties') }))}
  />
);
