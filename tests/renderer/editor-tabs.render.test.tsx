import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditorTabs } from '../../src/renderer/components/editor/editor-tabs';
import { I18nContext } from '../../src/renderer/i18n/i18n-context';
import { makeT } from '../../src/renderer/i18n/messages';

function renderTabs(props: Partial<React.ComponentProps<typeof EditorTabs>> = {}) {
  const full: React.ComponentProps<typeof EditorTabs> = {
    tabs: ['src/a.ts', 'src/b.ts'],
    active: 'src/b.ts',
    preview: null,
    dirty: false,
    saveError: false,
    onActivate: vi.fn(),
    onPin: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseAll: vi.fn(),
    ...props,
  };
  render(
    <I18nContext.Provider value={{ locale: 'en', t: makeT('en') }}>
      <EditorTabs {...full} />
    </I18nContext.Provider>,
  );
  return full;
}

describe('<EditorTabs>', () => {
  it('renders a tab per open file showing the base name, marking the active one', () => {
    renderTabs();
    expect(screen.getByTestId('editor-tab-src/a.ts').textContent).toContain('a.ts');
    expect(screen.getByTestId('editor-tab-src/b.ts').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('editor-tab-src/a.ts').getAttribute('aria-selected')).toBe('false');
  });

  it('clicking a tab activates it; clicking × closes it (without activating)', () => {
    const props = renderTabs();
    fireEvent.click(screen.getByTestId('editor-tab-src/a.ts'));
    expect(props.onActivate).toHaveBeenCalledWith('src/a.ts');
    fireEvent.click(screen.getByTestId('editor-tab-close-src/a.ts'));
    expect(props.onClose).toHaveBeenCalledWith('src/a.ts');
  });

  it('middle-click closes a tab', () => {
    const props = renderTabs();
    fireEvent(
      screen.getByTestId('editor-tab-src/b.ts'),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    expect(props.onClose).toHaveBeenCalledWith('src/b.ts');
  });

  it('shows a status dot on the active tab only when dirty, error-coloured on save failure', () => {
    renderTabs({ dirty: true });
    expect(screen.getByTestId('editor-tab-dot-src/b.ts')).toBeTruthy();
    expect(screen.queryByTestId('editor-tab-dot-src/a.ts')).toBeNull(); // inactive never shows
    expect(screen.getByTestId('editor-tab-dot-src/b.ts').className).not.toContain('err');
  });

  it('marks the dot with the error class when the active tab failed to save', () => {
    renderTabs({ dirty: true, saveError: true });
    expect(screen.getByTestId('editor-tab-dot-src/b.ts').className).toContain('err');
  });

  it('right-click opens a menu whose items close others / close all', () => {
    const props = renderTabs();
    expect(screen.queryByTestId('tab-menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('editor-tab-src/a.ts'));
    expect(screen.getByTestId('tab-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-menu-close-others'));
    expect(props.onCloseOthers).toHaveBeenCalledWith('src/a.ts');
    expect(screen.queryByTestId('tab-menu')).toBeNull(); // menu closes after the action
  });

  it('the close-all menu item triggers onCloseAll and a backdrop click dismisses the menu', () => {
    const props = renderTabs();
    fireEvent.contextMenu(screen.getByTestId('editor-tab-src/b.ts'));
    fireEvent.click(screen.getByTestId('tab-menu-close-all'));
    expect(props.onCloseAll).toHaveBeenCalled();
    // reopen, then dismiss via the backdrop
    fireEvent.contextMenu(screen.getByTestId('editor-tab-src/b.ts'));
    fireEvent.click(screen.getByTestId('tab-menu-backdrop'));
    expect(screen.queryByTestId('tab-menu')).toBeNull();
  });

  it('renders nothing but the container when there are no tabs', () => {
    renderTabs({ tabs: [], active: null });
    expect(screen.getByTestId('editor-tabs').childElementCount).toBe(0);
  });

  it('marks the preview tab with the preview class (italic) and only that one', () => {
    renderTabs({ preview: 'src/a.ts' });
    expect(screen.getByTestId('editor-tab-src/a.ts').className).toContain('preview');
    expect(screen.getByTestId('editor-tab-src/b.ts').className).not.toContain('preview');
  });

  it('double-clicking a tab pins it', () => {
    const props = renderTabs({ preview: 'src/a.ts' });
    fireEvent.doubleClick(screen.getByTestId('editor-tab-src/a.ts'));
    expect(props.onPin).toHaveBeenCalledWith('src/a.ts');
  });
});
