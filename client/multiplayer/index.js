import api from '../scripts/api/index.js';

const ROOM_NAME_MAX_LENGTH = 32;

document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault();

  let roomName = document.getElementById('new-room-name').value;
  if (roomName.length === 0) {
    roomName = document.getElementById('new-room-name').placeholder;
  } else {
    roomName = roomName.replaceAll(' ', '-');
  }

  roomName = roomName.substring(0, ROOM_NAME_MAX_LENGTH);

  const isPrivate = document.getElementById('private-room-checkbox').checked;
  const isControlled = document.getElementById('controlled-room-checkbox').checked;

  const params = new URLSearchParams();

  if (isPrivate) params.set('private', 'true');
  if (isControlled) params.set('controlled', 'true');

  window.location.href = `/multiplayer/${encodeURIComponent(roomName)}?${params.toString()}`;
});

fetch('/api/multiplayer/room-list')
  .then(response => response.json())
  .then(data => {
    const { activePlayers, activeRooms, roomList } = data;
    document.getElementById('active-players').textContent = activePlayers;
    document.getElementById('active-rooms').textContent = activeRooms;

    roomList.sort((a, b) => {
      if (a.onlineCount === b.onlineCount) {
        return b.playerCount - a.playerCount;
      } else {
        return b.onlineCount - a.onlineCount;
      }
    });

    roomList.forEach(room => {
      const { roomName, playerCount, onlineCount, isPermanent } = room;

      const a = document.createElement('a');
      a.href = `/multiplayer/${encodeURIComponent(roomName)}`;
      a.textContent = roomName;

      const li = document.createElement('li');
      li.appendChild(a);
      li.appendChild(document.createTextNode(` - ${playerCount} player${playerCount === 1 ? '' : 's'} - ${onlineCount} online`));
      li.classList.add('list-group-item');
      if (onlineCount === 0 && !isPermanent) {
        li.classList.add('d-none');
        li.classList.add('empty-room');
      }

      if (isPermanent) {
        document.getElementById('permanent-room-list').appendChild(li);
      } else {
        document.getElementById('room-list').appendChild(li);
      }
    });
  });

document.getElementById('new-room-name').placeholder = api.getRandomName();

document.getElementById('empty-room-checkbox').addEventListener('change', function (event) {
  const emptyRooms = document.getElementsByClassName('empty-room');
  for (const emptyRoom of emptyRooms) {
    emptyRoom.classList.toggle('d-none', !event.target.checked);
  }
});
