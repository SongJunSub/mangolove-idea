import { Logo } from './logo';

/**
 * Frameless macOS titlebar. The window is created with titleBarStyle:'hiddenInset',
 * so the standard traffic-light controls overlay the top-left; this bar fills the rest
 * of that row with the brand and is the window's drag region (-webkit-app-region: drag,
 * set in theme.css; interactive children opt out with no-drag). A2b moves the primary
 * toolbar actions up here; for now it carries the brand.
 */
export function Titlebar(): React.JSX.Element {
  return (
    <div className="titlebar" data-testid="titlebar">
      <Logo size={22} />
      <span className="titlebar-brand">
        <span className="brand-mango">Mango</span>
        <span className="brand-love">Love</span> IDEA
      </span>
      <span className="titlebar-spacer" />
    </div>
  );
}
