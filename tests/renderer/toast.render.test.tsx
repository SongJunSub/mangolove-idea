import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toast } from '../../src/renderer/components/toast/toast';

describe('<Toast>', () => {
  it('renders the message and calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<Toast message="Moved to the existing window" closeLabel="Close" onClose={onClose} />);
    expect(screen.getByTestId('toast')).toHaveTextContent('Moved to the existing window');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
