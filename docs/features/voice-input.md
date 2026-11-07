# Voice input (speech-to-text in the chat)

The chat widget can take spoken input: the microphone button records the user,
streams the audio to Amazon Transcribe over a WebSocket, shows the transcript
live, and — when the user stops talking — sends the message automatically.

## User-facing behaviour

1. **Click the mic = start.** While recording the button is clearly **red** and
   wears a glowing ring.
2. **Live level meter.** The ring glow grows and brightens with the input level
   (RMS), so the user can see the mic is hearing them. It respects
   `prefers-reduced-motion` (a steady ring instead of an animated one).
3. **Live transcription.** Partial transcripts appear above the input as the
   user speaks; language follows the **PL / EN** toggle next to the mic.
4. **Auto-stop + auto-send.** When the user goes quiet for ~1.5 s after a final
   transcript has arrived, recording stops and the recognised message is sent
   automatically.
5. **Manual controls.**
   - Click while recording = **stop immediately** and send what was recognised.
   - **Esc** cancels and sends nothing.
   - **Ctrl+M** toggles start/stop (and opens the chat if it is closed).
6. **In-flight loading ring.** After a message is sent, while the assistant's
   reply is streaming, a circular loading ring animates **around** the mic
   button. It clears when the reply finishes.
7. **Never records forever.** Two safety nets stop a runaway recording:
   - a long initial silence with nothing said stops quietly (no send);
   - a hard cap of **60 s** always stops recording (sending whatever text was
     recognised).
   Any backend/transcription error stops recording and shows a visible message.

## Architecture

```
MicButton.tsx ──uses──▶ useVoiceInput.ts ──drives──▶ voiceMachine.ts (pure VAD)
      │                       │
      │                       └── WebSocket /api/transcribe/stream (16 kHz PCM)
      │                                     │
      ▼                                     ▼
  ChatWidget (busy/disabled,        app/api/routes/transcribe.py
   PL/EN toggle, onFinal send)       app/services/transcribe.py (Amazon Transcribe)
```

- **`voiceMachine.ts`** is a pure, unit-tested reducer. It holds no browser or
  AWS APIs. It runs a local RMS voice-activity detector (VAD) and decides, from
  audio-frame RMS plus Transcribe final results, when to stop and whether to
  auto-send. Timings are configurable constants: `SILENCE_AFTER_SPEECH_MS`
  (1500), `SILENCE_NO_SPEECH_MS` (8000), `MAX_RECORDING_MS` (60000) and
  `VAD_RMS_THRESHOLD` (0.015).
- **`useVoiceInput.ts`** is the impure hook: it captures the microphone with
  `getUserMedia`, downsamples to 16 kHz 16-bit PCM, streams it to the backend
  WebSocket, feeds frame RMS and transcript events into the machine, and runs
  the machine's effects (teardown / final). Teardown disconnects the audio
  graph, closes the `AudioContext`, stops the mic tracks and closes the socket.
- **`MicButton.tsx`** renders the states: `recording` (red + level ring),
  `requesting` (spinner), `busy` (in-flight loading ring), and errors.
- **Backend** `app/api/routes/transcribe.py` is the WebSocket endpoint;
  `app/services/transcribe.py` wraps the `amazon-transcribe` streaming SDK and
  turns its results into `partial` / `final` / `error` JSON messages. The AWS
  streamer is injected behind a factory so tests use a fake with no AWS call.

## Dev-server proxy (important)

The transcription endpoint is a **WebSocket**. The Vite dev server must proxy
WebSocket upgrades, so `frontend/vite.config.ts` sets `ws: true` on the `/api`
proxy:

```ts
proxy: {
  '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true, ws: true },
}
```

Without `ws: true` the upgrade to `/api/transcribe/stream` is dropped: no
transcript ever arrives, the VAD never sees a final result, and the mic records
indefinitely. This was the root cause of the "records forever, sends nothing,
no meter, not red" report.

## AWS

Credentials come from the standard AWS chain (SSO / `aws configure`). Only the
region is configured (`AWS_REGION`, default `eu-central-1`). Streaming languages
supported: `pl-PL` (default) and `en-US`.
