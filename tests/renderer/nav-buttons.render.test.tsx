import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NavButtons } from '../../src/renderer/components/editor/nav-buttons';
import { I18nContext } from '../../src/renderer/i18n/i18n-context';
import { makeT } from '../../src/renderer/i18n/messages';

function renderNav(props: Partial<React.ComponentProps<typeof NavButtons>> = {}) {
  const full: React.ComponentProps<typeof NavButtons> = {
    canGoBack: true,
    canGoForward: true,
    onBack: vi.fn(),
    onForward: vi.fn(),
    ...props,
  };
  render(
    <I18nContext.Provider value={{ locale: 'en', t: makeT('en') }}>
      <NavButtons {...full} />
    </I18nContext.Provider>,
  );
  return full;
}

describe('<NavButtons>', () => {
  it('renders a back and a forward button', () => {
    renderNav();
    expect(screen.getByTestId('nav-back')).toBeTruthy();
    expect(screen.getByTestId('nav-forward')).toBeTruthy();
  });

  it('disables each button when its stack is empty', () => {
    renderNav({ canGoBack: false, canGoForward: false });
    expect(screen.getByTestId('nav-back')).toBeDisabled();
    expect(screen.getByTestId('nav-forward')).toBeDisabled();
  });

  it('fires onBack / onForward when the enabled buttons are clicked', () => {
    const p = renderNav();
    fireEvent.click(screen.getByTestId('nav-back'));
    fireEvent.click(screen.getByTestId('nav-forward'));
    expect(p.onBack).toHaveBeenCalled();
    expect(p.onForward).toHaveBeenCalled();
  });
});
