# Bounce Lounge

A cozy little video room for you and your friends. Talk face to face, share a screen
on the big main stage, or put a YouTube / Vimeo video or web link up for everyone.

- Rooms with a short shareable link (like `/room/abc-defg`). Whoever opens the room first is the host.
- Video and audio for 2 to 6 people, with mic and camera on/off buttons.
- A main stage in the middle that follows whoever is talking, with everyone's tiles around it.
- Screen sharing (with tab or system audio when your browser allows it). One share at a time.
- Shared links on the main stage. YouTube and Vimeo play in sync for everyone.
- Morning (light) and evening (dark) themes.

## What you need

- Node.js 18 or newer
- A modern browser (Chrome or Firefox work well)

On Arch Linux:

```bash
sudo pacman -S nodejs npm git
```

## Install and run

```bash
npm install
npm start
```

Open http://localhost:3000. During development, `npm run dev` restarts the server when you edit it.
To use a different port: `PORT=4000 npm start`.

To try it alone, open the invite link in a second window (a normal window plus an
incognito one works well). Use headphones, or mute one window, to avoid echo.

## Let your friends join

Browsers only allow camera and microphone access on `localhost` or over HTTPS. A plain
`http://192.168.x.x:3000` address will not work for your friends. The easiest fix is a tunnel,
which gives your local server a temporary public HTTPS address.

### Option A: Cloudflare quick tunnel (no account)

1. Install cloudflared. On Arch: `sudo pacman -Syu cloudflared` (this also updates your system).
   Other systems: see Cloudflare's download page.
2. Start Bounce Lounge in one terminal: `npm start`
3. In a second terminal:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

4. After a few seconds it prints an address like `https://something-random.trycloudflare.com`.
5. Open that address yourself (not localhost), create a room there, and send the invite link to your friends.

Good to know: the address changes every time you start the tunnel, it works only while the
command is running, and anyone who has the address can open your app, so share it only with
friends. Cloudflare says quick tunnels have no uptime guarantee and are meant for testing,
so use a named tunnel or a real host for anything long term.

### Option B: ngrok

Create a free account at ngrok.com, set up the `ngrok` command as they describe, then run
`ngrok http 3000` and use the https address it prints, the same way as Option A.

### Option C: Deploy it

Any host that runs Node.js, gives you HTTPS, and supports WebSockets will work. The start command
is `npm start`, and the app reads the `PORT` environment variable. Rooms live in memory,
so they disappear when the server restarts.

## When video does not connect (TURN)

Calls go directly between browsers (peer to peer), using Google's public STUN servers to find
a path. Most home networks work fine. Some networks (strict company or school Wi-Fi, some
mobile carriers) block direct connections, and then people see each other as blank tiles, or
you get a "Could not connect to..." message. The fix is a TURN server, which relays the media.

Get TURN details from a TURN provider, or run your own with the open source coturn, then start
the server with:

```bash
TURN_URL="turn:turn.example.com:3478" TURN_USERNAME="your-user" TURN_CREDENTIAL="your-password" npm start
```

`TURN_URL` can hold several addresses separated by commas.

## Using the room

- **M** toggles your microphone and **V** toggles your camera (when you are not typing).
- **Screen share:** pick a screen, window, or tab. Tick the audio option in the browser's picker to share sound.
  If someone else is sharing you will be asked to wait. The sharer, or the host, can stop a share.
- **Links:** the link button opens a box. YouTube and Vimeo play in sync. Most other websites refuse to be
  shown inside another page, so Bounce Lounge checks first and shows a link card with an
  "Open in new tab" button when a site says no. Anyone can clear the stage.
- **Limits:** 6 people per room. Everyone connects to everyone, which is great for a few friends and
  would not scale to a big meeting.

## Troubleshooting

| Problem | Try this |
| --- | --- |
| Camera or mic blocked | Click the lock icon in the address bar, allow camera and microphone, reload. |
| "Camera and mic need a secure connection" | Open the app on `localhost` or over HTTPS (see the tunnel section). |
| Second window has no camera | One webcam often cannot be used by two windows at once. It joins as a viewer. |
| Echo or feedback | Use headphones, or mute one of the windows. |
| Blank tile for one friend | Likely a network that needs TURN (see above). |
| No sound from a shared screen | The sharer must tick "share audio" in the picker. Tab audio is the most reliable. |
| Shared link shows a card | That site does not allow embedding. Use "Open in new tab". |
| Video will not auto-play for a viewer | The browser blocked autoplay. Press play once, and sync continues. |
| Everyone got kicked after a restart | Rooms live in memory. Restarting the server ends them. Rejoin with the same link. |

## Privacy

There is no database and nothing is saved. Anyone who has a room link can join (there are no
passwords), so treat links like keys and share them only with friends.

## Project layout

```
server.js            Express + Socket.IO: rooms, host, signaling, screen share and link state
links.js             Link parsing and the "can this site be embedded?" check
public/
  index.html         Home page
  room.html          Pre-join screen + the room
  css/style.css      Cozy theme (light + evening) as CSS variables
  js/common.js       Icons, theme toggle, toasts
  js/home.js         Create / join
  js/room.js         Room logic and controls
  js/webrtc.js       Peer connections and renegotiation
  js/audio.js        Speaking detection
  js/stage.js        The main stage (person, screen, link)
```
