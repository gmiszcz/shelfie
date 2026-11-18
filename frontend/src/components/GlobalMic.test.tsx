import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MicButtonProps, MicHandle } from './MicButton';

/**
 * GlobalMic tests.
 *
 * The real MicButton wraps the audio hook (getUserMedia / WebSocket), which is
 * covered in useVoiceInput.test.ts. Here MicButton is mocked to a thin test
 * harness that (a) exposes a "speak" button which calls `onFinal` with a final
 * transcript, (b) exposes an "error" button which calls `onError`, and (c)
 * forwards an imperative handle — so we exercise GlobalMic's own behaviour:
 * sending the transcript to the UI agent WITHOUT opening the chat, the result
 * toast, and tap-to-open-chat.
 */

const FAKE_REPLY = 'Otworzyłem statystyki.';

// Capture the latest props passed to the mocked MicButton so tests can drive it.
let micProps: MicButtonProps | null = null;

vi.mock('./MicButton', async () => {
  const React = await import('react');
  return {
    MicButton: React.forwardRef<MicHandle, MicButtonProps>(function MockMic(props, ref) {
      micProps = props;
      React.useImperativeHandle(ref, () => ({
        toggle: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
        isRecording: () => false,
      }));
      return (
        <div>
          <button type="button" onClick={() => props.onFinal('pokaż statystyki', { autoSend: true })}>
            speak
          </button>
          <button type="button" onClick={() => props.onError?.('The microphone needs HTTPS.')}>
            mic-error
          </button>
          {props.busy ? <span data-testid="mic-busy">busy</span> : null}
        </div>
      );
    }),
  };
});

// A deterministic assistant run: no tools, one text reply.
const ask = vi.fn(async (_agent: unknown, _message: string, chat: { onText: (d: string) => void }) => {
  chat.onText(FAKE_REPLY);
  return FAKE_REPLY;
});

vi.mock('../agui/agent', () => ({
  ask: (agent: unknown, message: string, chat: never) => ask(agent, message, chat),
  newAgent: () => ({ threadId: 't', abortRun: vi.fn() }),
  forgetThread: vi.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import { ChatProvider, useChat } from '../chat/ChatProvider';
// eslint-disable-next-line import/first
import { GlobalMic } from './GlobalMic';
// eslint-disable-next-line import/first
import { SettingsProvider } from '../settings/SettingsContext';
// eslint-disable-next-line import/first
import { QueryWrapper } from '../queries/testUtils';

/** A probe exposing the shared chat `open` flag and message count to assertions. */
function OpenProbe() {
  const { open, state } = useChat();
  return (
    <>
      <span data-testid="chat-open">{open ? 'open' : 'closed'}</span>
      <span data-testid="chat-msgcount">{state.messages.length}</span>
    </>
  );
}

function renderGlobalMic() {
  return render(
    <QueryWrapper>
      <SettingsProvider>
        <ChatProvider>
          <OpenProbe />
          <GlobalMic />
        </ChatProvider>
      </SettingsProvider>
    </QueryWrapper>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  micProps = null;
  ask.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('GlobalMic', () => {
  it('renders the floating mic when the setting is on', () => {
    renderGlobalMic();
    expect(micProps).not.toBeNull();
    expect(micProps?.variant).toBe('global');
    // It does not own Ctrl+M (the shell routes it).
    expect(micProps?.captureShortcuts).toBe(false);
  });

  it('sends the transcript to the assistant WITHOUT opening the chat', async () => {
    renderGlobalMic();
    expect(screen.getByTestId('chat-open').textContent).toBe('closed');

    await act(async () => {
      fireEvent.click(screen.getByText('speak'));
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1]).toBe('pokaż statystyki');
    // The chat panel stayed closed the whole time.
    expect(screen.getByTestId('chat-open').textContent).toBe('closed');
  });

  it('shows a toast with the transcript and the agent reply', async () => {
    renderGlobalMic();
    await act(async () => {
      fireEvent.click(screen.getByText('speak'));
    });
    await waitFor(() => expect(screen.getByText(FAKE_REPLY)).toBeTruthy());
    expect(screen.getByText(/pokaż statystyki/)).toBeTruthy();
    expect(screen.getByText(/Tap to open in chat/i)).toBeTruthy();
  });

  it('tapping the toast opens the chat with the exchange in the thread', async () => {
    renderGlobalMic();
    await act(async () => {
      fireEvent.click(screen.getByText('speak'));
    });
    await waitFor(() => expect(screen.getByText(FAKE_REPLY)).toBeTruthy());
    // The head-less run appended the user + assistant messages to the shared thread.
    const countBeforeTap = Number(screen.getByTestId('chat-msgcount').textContent);
    expect(countBeforeTap).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByText(FAKE_REPLY));
    });

    // Regression: tapping must open the chat WITH the spoken exchange still present.
    await waitFor(() => expect(screen.getByTestId('chat-open').textContent).toBe('open'));
    expect(Number(screen.getByTestId('chat-msgcount').textContent)).toBe(countBeforeTap);
  });

  it('shows the HTTPS mic error in the toast (insecure origin)', async () => {
    renderGlobalMic();
    await act(async () => {
      fireEvent.click(screen.getByText('mic-error'));
    });
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toMatch(/HTTPS/);
    // An error toast is not tappable into the chat.
    expect(screen.queryByText(/Tap to open in chat/i)).toBeNull();
  });

  it('auto-hides the toast after the timeout', async () => {
    renderGlobalMic();
    await act(async () => {
      fireEvent.click(screen.getByText('speak'));
    });
    await waitFor(() => expect(screen.getByText(FAKE_REPLY)).toBeTruthy());
    await act(async () => {
      vi.advanceTimersByTime(6500);
    });
    await waitFor(() => expect(screen.queryByText(FAKE_REPLY)).toBeNull());
  });
});
