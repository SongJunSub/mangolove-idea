import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenuTemplate } from '../../src/main/app/app-menu';

describe('buildAppMenuTemplate', () => {
  it('keeps the standard macro roles so native copy/paste/quit + the window list survive', () => {
    const template = buildAppMenuTemplate({ onNewWindow: vi.fn() }, true);
    const roles = template.map((m) => m.role).filter(Boolean);
    expect(roles).toEqual(
      expect.arrayContaining(['appMenu', 'editMenu', 'viewMenu', 'windowMenu']),
    );
  });

  it('File > New Window carries the accelerator and invokes onNewWindow', () => {
    const onNewWindow = vi.fn();
    const template = buildAppMenuTemplate({ onNewWindow }, true);
    const file = template.find((m) => m.label === 'File');
    const items = file?.submenu as MenuItemConstructorOptions[];
    const newWindow = items.find((i) => i.label === 'New Window');
    expect(newWindow?.accelerator).toBe('CmdOrCtrl+Shift+N');
    newWindow?.click?.(undefined as never, undefined, undefined as never);
    expect(onNewWindow).toHaveBeenCalledOnce();
  });

  it('omits the app menu and uses Quit (not Close) off macOS', () => {
    const template = buildAppMenuTemplate({ onNewWindow: vi.fn() }, false);
    expect(template.some((m) => m.role === 'appMenu')).toBe(false);
    const file = template.find((m) => m.label === 'File');
    const items = file?.submenu as MenuItemConstructorOptions[];
    expect(items.some((i) => i.role === 'quit')).toBe(true);
    expect(items.some((i) => i.role === 'close')).toBe(false);
  });
});
