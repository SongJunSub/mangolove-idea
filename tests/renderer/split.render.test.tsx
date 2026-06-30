import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Split } from '../../src/renderer/components/layout/split';

/** A controlled wrapper that feeds onResize back into `size`, like the real pane-layout hook. */
function Harness(props: {
  onResize?: (s: number) => void;
  onResizeEnd?: (s: number) => void;
  initial?: number;
}): React.JSX.Element {
  const [size, setSize] = useState(props.initial ?? 264);
  return (
    <Split
      axis="x"
      unit="px"
      size={size}
      min={160}
      max={640}
      minSecondPx={240}
      defaultSize={264}
      onResize={(s) => {
        setSize(s);
        props.onResize?.(s);
      }}
      onResizeEnd={(s) => props.onResizeEnd?.(s)}
      label="resize columns"
      testId="gutter"
      first={<div data-testid="pane-a" />}
      second={<div data-testid="pane-b" />}
    />
  );
}

function mockContainerRect(): void {
  const gutter = screen.getByTestId('gutter');
  const container = gutter.parentElement as HTMLElement;
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
      right: 1200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('<Split>', () => {
  it('renders both panes and a separator gutter', () => {
    render(<Harness />);
    expect(screen.getByTestId('pane-a')).toBeInTheDocument();
    expect(screen.getByTestId('pane-b')).toBeInTheDocument();
    expect(screen.getByTestId('gutter')).toHaveAttribute('role', 'separator');
  });

  it('drag updates size live and persists once on pointer-up', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    render(<Harness onResize={onResize} onResizeEnd={onResizeEnd} />);
    mockContainerRect();
    const gutter = screen.getByTestId('gutter');
    fireEvent.pointerDown(gutter, { pointerId: 1, buttons: 1, clientX: 264, clientY: 0 });
    fireEvent.pointerMove(gutter, { pointerId: 1, buttons: 1, clientX: 400, clientY: 0 });
    expect(onResize).toHaveBeenLastCalledWith(400);
    fireEvent.pointerUp(gutter, { pointerId: 1 });
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenCalledWith(400);
  });

  it('a click on the gutter without moving does NOT persist', () => {
    const onResizeEnd = vi.fn();
    render(<Harness onResizeEnd={onResizeEnd} />);
    mockContainerRect();
    const gutter = screen.getByTestId('gutter');
    fireEvent.pointerDown(gutter, { pointerId: 1, buttons: 1, clientX: 264, clientY: 0 });
    fireEvent.pointerUp(gutter, { pointerId: 1 });
    expect(onResizeEnd).not.toHaveBeenCalled();
  });

  it('double-click resets to the default size and persists it', () => {
    const onResizeEnd = vi.fn();
    render(<Harness initial={420} onResizeEnd={onResizeEnd} />);
    fireEvent.doubleClick(screen.getByTestId('gutter'));
    expect(onResizeEnd).toHaveBeenCalledWith(264);
  });
});
