import { ANSWER_TIME_LIMIT, DEAD_TIME_LIMIT, TOSSUP_PROGRESS_ENUM } from './constants.js';
import insertTokensIntoHTML from './insert-tokens-into-html.js';
import QuestionRoom from './QuestionRoom.js';

export default class TossupRoom extends QuestionRoom {
  constructor (name, categories = [], subcategories = [], alternateSubcategories = []) {
    super(name, categories, subcategories, alternateSubcategories);

    this.timeoutID = null;
    /**
     * @type {string | null}
     * The userId of the player who buzzed in.
     * We should ensure that buzzedIn is null before calling any readQuestion.
     */
    this.buzzedIn = null;
    this.buzzes = [];
    this.buzzpointIndices = [];
    this.liveAnswer = '';
    this.paused = false;
    this.questionSplit = [];
    this.tossup = {};
    this.tossupProgress = TOSSUP_PROGRESS_ENUM.NOT_STARTED;
    this.wordIndex = 0;

    this.query = {
      ...this.query,
      powermarkOnly: false
    };

    this.settings = {
      ...this.settings,
      rebuzz: false,
      readingSpeed: 50
    };

    this.previous = {
      celerity: 0,
      endOfQuestion: false,
      isCorrect: true,
      inPower: false,
      negValue: -5,
      powerValue: 15,
      tossup: {},
      userId: null
    };
  }

  async message (userId, message) {
    switch (message.type) {
      case 'buzz': return this.buzz(userId, message);
      case 'clear-stats': return this.clearStats(userId, message);
      case 'end': return this.next(userId, message);
      case 'give-answer': return this.giveAnswer(userId, message);
      case 'next': return this.next(userId, message);
      case 'pause': return this.pause(userId, message);
      case 'set-reading-speed': return this.setReadingSpeed(userId, message);
      case 'skip': return this.next(userId, message);
      case 'start': return this.next(userId, message);
      case 'toggle-powermark-only': return this.togglePowermarkOnly(userId, message);
      case 'toggle-rebuzz': return this.toggleRebuzz(userId, message);
      case 'toggle-public': return this.togglePublic(userId, message);
      default: return super.message(userId, message);
    }
  }

  buzz (userId) {
    if (!this.settings.rebuzz && this.buzzes.includes(userId)) { return; }
    if (this.tossupProgress !== TOSSUP_PROGRESS_ENUM.READING) { return; }

    const username = this.players[userId].username;
    if (this.buzzedIn) {
      this.emitMessage({ type: 'lost-buzzer-race', userId, username });
      return;
    }

    clearTimeout(this.timeoutID);
    this.buzzedIn = userId;
    this.buzzes.push(userId);
    this.buzzpointIndices.push(this.questionSplit.slice(0, this.wordIndex).join(' ').length);
    this.paused = false;

    this.emitMessage({ type: 'buzz', userId, username });
    this.emitMessage({ type: 'update-question', word: '(#)' });

    this.startServerTimer(
      ANSWER_TIME_LIMIT * 10,
      (time) => this.emitMessage({ type: 'timer-update', timeRemaining: time }),
      () => this.giveAnswer(userId, { givenAnswer: this.liveAnswer })
    );
  }

  clearStats (userId) {
    this.players[userId].clearStats();
    this.emitMessage({ type: 'clear-stats', userId });
  }

  giveAnswer (userId, { givenAnswer }) {
    if (typeof givenAnswer !== 'string') { return false; }
    if (this.buzzedIn !== userId) { return false; }

    this.liveAnswer = '';
    clearInterval(this.timer.interval);
    this.emitMessage({ type: 'timer-update', timeRemaining: ANSWER_TIME_LIMIT * 10 });

    if (Object.keys(this.tossup || {}).length === 0) { return; }

    const { celerity, directive, directedPrompt, points } = this.scoreTossup({ givenAnswer });

    switch (directive) {
      case 'accept':
        this.buzzedIn = null;
        this.revealQuestion();
        this.players[userId].updateStats(points, celerity);
        Object.values(this.players).forEach(player => { player.tuh++; });
        break;
      case 'reject':
        this.buzzedIn = null;
        this.players[userId].updateStats(points, celerity);
        if (!this.settings.rebuzz && this.buzzes.length === Object.keys(this.sockets).length) {
          this.revealQuestion();
          Object.values(this.players).forEach(player => { player.tuh++; });
        } else {
          this.readQuestion(Date.now());
        }
        break;
      case 'prompt':
        this.startServerTimer(
          ANSWER_TIME_LIMIT * 10,
          (time) => this.emitMessage({ type: 'timer-update', timeRemaining: time }),
          () => this.giveAnswer(userId, { givenAnswer: this.liveAnswer })
        );
    }

    this.emitMessage({
      type: 'give-answer',
      userId,
      username: this.players[userId].username,
      givenAnswer,
      directive,
      directedPrompt,
      score: points,
      celerity: this.players[userId].celerity.correct.average,
      // the below fields are used to record buzzpoint data
      tossup: this.tossup,
      perQuestionCelerity: celerity
    });
  }

  /**
   * Logic for when the user presses the next button.
   * @param {string} userId - The userId of the user who pressed the next button.
   * @param {'next' | 'skip' | 'start'} type - The type of next button pressed.
   * @returns
   */
  async next (userId, { type }) {
    if (this.buzzedIn) { return false; } // prevents skipping when someone has buzzed in
    if (this.queryingQuestion) { return false; }
    if (this.tossupProgress === TOSSUP_PROGRESS_ENUM.READING && !this.settings.skip) { return false; }

    const username = this.players[userId].username;

    clearInterval(this.timer.interval);
    this.emitMessage({ type: 'timer-update', timeRemaining: 0 });

    clearTimeout(this.timeoutID);
    this.buzzedIn = null;
    this.buzzes = [];
    this.buzzpointIndices = [];
    this.paused = false;

    if (this.tossupProgress !== TOSSUP_PROGRESS_ENUM.ANSWER_REVEALED) { this.revealQuestion(); }

    const oldTossup = this.tossup;
    this.tossup = await this.advanceQuestion();
    this.queryingQuestion = false;
    if (!this.tossup) {
      this.emitMessage({ type: 'end', oldTossup, userId, username });
      return false;
    }
    this.questionSplit = this.tossup.question_sanitized.split(' ').filter(word => word !== '');

    this.emitMessage({ type, packetLength: this.packetLength, oldTossup, tossup: this.tossup, userId, username });

    this.wordIndex = 0;
    this.tossupProgress = TOSSUP_PROGRESS_ENUM.READING;
    this.readQuestion(Date.now());
  }

  pause (userId) {
    if (this.buzzedIn) { return false; }
    if (this.tossupProgress === TOSSUP_PROGRESS_ENUM.ANSWER_REVEALED) { return false; }

    this.paused = !this.paused;
    if (this.paused) {
      clearTimeout(this.timeoutID);
      clearInterval(this.timer.interval);
    } else if (this.wordIndex >= this.questionSplit.length) {
      this.startServerTimer(
        this.timer.timeRemaining,
        (time) => this.emitMessage({ type: 'timer-update', timeRemaining: time }),
        () => this.revealQuestion()
      );
    } else {
      this.readQuestion(Date.now());
    }
    const username = this.players[userId].username;
    this.emitMessage({ type: 'pause', paused: this.paused, username });
  }

  scoreTossup ({ givenAnswer }) {
    const celerity = this.questionSplit.slice(this.wordIndex).join(' ').length / this.tossup.question.length;
    const endOfQuestion = (this.wordIndex === this.questionSplit.length);
    const inPower = Math.max(this.questionSplit.indexOf('(*)'), this.questionSplit.indexOf('[*]')) >= this.wordIndex;
    const { directive, directedPrompt } = this.checkAnswer(this.tossup.answer, givenAnswer, this.settings.strictness);
    const isCorrect = directive === 'accept';
    const points = isCorrect ? (inPower ? this.previous.powerValue : 10) : (endOfQuestion ? 0 : this.previous.negValue);

    this.previous = {
      ...this.previous,
      celerity,
      endOfQuestion,
      inPower,
      isCorrect,
      tossup: this.tossup,
      userId: this.buzzedIn
    };

    return { celerity, directive, directedPrompt, endOfQuestion, inPower, points };
  }

  setReadingSpeed (userId, { readingSpeed }) {
    if (!this.allowed(userId)) return false;
    if (isNaN(readingSpeed)) { return false; }
    if (readingSpeed > 100) { readingSpeed = 100; }
    if (readingSpeed < 0) { readingSpeed = 0; }

    this.settings.readingSpeed = readingSpeed;
    const username = this.players[userId].username;
    this.emitMessage({ type: 'set-reading-speed', username, readingSpeed });
  }

  async readQuestion (expectedReadTime) {
    if (Object.keys(this.tossup || {}).length === 0) { return; }
    if (this.wordIndex >= this.questionSplit.length) {
      this.startServerTimer(
        DEAD_TIME_LIMIT * 10,
        (time) => this.emitMessage({ type: 'timer-update', timeRemaining: time }),
        () => this.revealQuestion()
      );
      return;
    }

    const word = this.questionSplit[this.wordIndex];
    this.wordIndex++;
    this.emitMessage({ type: 'update-question', word });

    // calculate time needed before reading next word
    let time = Math.log(word.length) + 1;
    if ((word.endsWith('.') && word.charCodeAt(word.length - 2) > 96 && word.charCodeAt(word.length - 2) < 123) ||
      word.slice(-2) === '.\u201d' || word.slice(-2) === '!\u201d' || word.slice(-2) === '?\u201d') {
      time += 2;
    } else if (word.endsWith(',') || word.slice(-2) === ',\u201d') {
      time += 0.75;
    } else if (word === '(*)' || word === '[*]') {
      time = 0;
    }

    time = time * 0.9 * (125 - this.settings.readingSpeed);
    const delay = time - Date.now() + expectedReadTime;

    this.timeoutID = setTimeout(() => {
      this.readQuestion(time + expectedReadTime);
    }, delay);
  }

  revealQuestion () {
    if (Object.keys(this.tossup || {}).length === 0) return;

    this.tossupProgress = TOSSUP_PROGRESS_ENUM.ANSWER_REVEALED;
    this.emitMessage({
      type: 'reveal-answer',
      question: insertTokensIntoHTML(this.tossup.question, this.tossup.question_sanitized, [this.buzzpointIndices], [' (#) ']),
      answer: this.tossup.answer
    });
  }

  togglePowermarkOnly (userId, { powermarkOnly }) {
    if (!this.allowed(userId)) return false;
    this.query.powermarkOnly = powermarkOnly;
    const username = this.players[userId].username;
    this.adjustQuery(['powermarkOnly'], [powermarkOnly]);
    this.emitMessage({ type: 'toggle-powermark-only', powermarkOnly, username });
  }

  toggleRebuzz (userId, { rebuzz }) {
    if (!this.allowed(userId)) return false;
    this.settings.rebuzz = rebuzz;
    const username = this.players[userId].username;
    this.emitMessage({ type: 'toggle-rebuzz', rebuzz, username });
  }
}
