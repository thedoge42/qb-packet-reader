import { PERMANENT_ROOMS, ROOM_NAME_MAX_LENGTH } from './constants.js';
import ServerTossupRoom from './ServerTossupRoom.js';
import { checkToken } from '../authentication.js';
import getRandomName from '../../quizbowl/get-random-name.js';
import hasValidCharacters from '../moderation/has-valid-characters.js';
import isAppropriateString from '../moderation/is-appropriate-string.js';

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import url from 'url';
import * as uuid from 'uuid';

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

const tossupRooms = {};
for (const room of PERMANENT_ROOMS) {
  const { name, categories, subcategories } = room;
  tossupRooms[name] = new ServerTossupRoom(name, '0', true, categories, subcategories);
}

/**
 * Returns the room with the given room name.
 * If the room does not exist, it is created.
 * @param {String} roomName
 * @returns {TossupRoom}
 */
function createAndReturnRoom (roomName, userId, isPrivate = false, isControlled = false) {
  roomName = DOMPurify.sanitize(roomName);
  roomName = roomName?.substring(0, ROOM_NAME_MAX_LENGTH) ?? '';

  if (!Object.prototype.hasOwnProperty.call(tossupRooms, roomName)) {
    const newRoom = new ServerTossupRoom(roomName, userId, false);
    newRoom.settings.public = !isPrivate;
    newRoom.settings.controlled = isControlled;
    tossupRooms[roomName] = newRoom;
  }

  return tossupRooms[roomName];
}

/**
 * Handle WebSocket connection
 * @param {WebSocket} ws
 * @param {http.IncomingMessage} req
 */
export default function handleWssConnection (ws, req) {
  const parsedUrl = new url.URL(req.url, process.env.BASE_URL ?? 'http://localhost');
  const isPrivate = parsedUrl.searchParams.get('private') === 'true';
  const isControlled = parsedUrl.searchParams.get('controlled') === 'true';
  const roomName = parsedUrl.searchParams.get('roomName');
  let userId = parsedUrl.searchParams.get('userId') ?? 'unknown';
  let username = parsedUrl.searchParams.get('username') ?? getRandomName();

  userId = (userId === 'unknown') ? uuid.v4() : userId;

  if (!hasValidCharacters(roomName)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'The room name contains an invalid character. Only A-Z, a-z, 0-9, - and _ are allowed.'
    }));
    return false;
  }

  if (!isAppropriateString(roomName)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'The room name contains an inappropriate word.'
    }));
    return false;
  }

  const room = createAndReturnRoom(roomName, userId, isPrivate, isControlled);
  if (room.settings.lock === true) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'The room is locked'
    }));
    return false;
  }

  if (room.settings.loginRequired === true) {
    const cookieString = (req?.headers?.cookie ?? 'session=;').split(';').find(token => token.trim().startsWith('session='));
    const cookieBuffer = Buffer.from(cookieString.split('=')[1], 'base64');
    let valid = true;
    try {
      const cookies = JSON.parse(cookieBuffer.toString('utf-8'));
      valid = checkToken(cookies.username, cookies.token, true);
    } catch (e) { valid = false; }

    if (!valid) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'You must be logged in with a verified email to join this room.'
      }));
      return false;
    }
  }

  if (!isAppropriateString(username)) {
    username = getRandomName();
    ws.send(JSON.stringify({
      type: 'force-username',
      username,
      message: 'Your username contains an inappropriate word, so it has been reset.'
    }));
  }

  room.connection(ws, userId, username);

  ws.on('error', (err) => {
    if (err instanceof RangeError) {
      console.log(`[WEBSOCKET] WARNING: Max payload exceeded from ip ${ws._socket.remoteAddress}`);
      ws.close();
    } else {
      console.log(err);
    }
  });
}

export { tossupRooms };
