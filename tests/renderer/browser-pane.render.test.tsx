import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserPane } from '../../src/renderer/components/browser/browser-pane';

describe('<BrowserPane>', () => {
  it('shows the empty placeholder (no webview) when no URL is detected', () => {
    render(<BrowserPane detectedUrl={null} />);
    expect(screen.getByTestId('browser-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('browser-webview')).not.toBeInTheDocument();
    expect(screen.getByTestId('browser-reload')).toBeDisabled(); // nothing to reload
  });

  it('seeds the URL bar from the detected URL and renders the webview', () => {
    render(<BrowserPane detectedUrl="http://localhost:5173/" />);
    expect(screen.getByTestId('browser-url')).toHaveValue('http://localhost:5173/');
    expect(screen.getByTestId('browser-webview')).toHaveAttribute('src', 'http://localhost:5173/');
  });

  it('Go commits the typed URL into the webview', () => {
    render(<BrowserPane detectedUrl={null} />);
    fireEvent.change(screen.getByTestId('browser-url'), {
      target: { value: 'http://localhost:3000' },
    });
    fireEvent.click(screen.getByTestId('browser-go'));
    expect(screen.getByTestId('browser-webview')).toHaveAttribute('src', 'http://localhost:3000');
  });

  it('a user-typed URL is sticky: a NEW detected URL does not clobber it (override)', () => {
    const { rerender } = render(<BrowserPane detectedUrl="http://localhost:5173/" />);
    fireEvent.change(screen.getByTestId('browser-url'), {
      target: { value: 'http://typed.local/' },
    });
    // Server restarts and reports a different URL — must NOT overwrite the user's input.
    rerender(<BrowserPane detectedUrl="http://localhost:4000/" />);
    expect(screen.getByTestId('browser-url')).toHaveValue('http://typed.local/');
  });
});
