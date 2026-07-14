export const WIDGET_CSS = `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    color: #e0e0e0;
  }

  .bl-trigger {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #dc2626;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    z-index: 2147483647;
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .bl-trigger:hover {
    transform: scale(1.1);
    background: #ef4444;
  }
  .bl-trigger svg {
    width: 24px;
    height: 24px;
    fill: white;
  }

  .bl-popover {
    position: fixed;
    bottom: 80px;
    right: 20px;
    width: 320px;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 2147483647;
    padding: 16px;
    display: none;
  }
  .bl-popover.open {
    display: block;
  }

  .bl-popover h3 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: #f5f5f5;
  }

  .bl-note {
    width: 100%;
    min-height: 60px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    color: #e0e0e0;
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
    box-sizing: border-box;
  }
  .bl-note::placeholder {
    color: #777;
  }
  .bl-note:focus {
    outline: none;
    border-color: #dc2626;
  }

  .bl-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    align-items: center;
  }

  .bl-btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.15s ease;
  }
  .bl-submit {
    background: #dc2626;
    color: white;
    flex: 1;
  }
  .bl-submit:hover {
    background: #ef4444;
  }
  .bl-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .bl-status {
    font-size: 11px;
    color: #777;
    margin-top: 8px;
  }

  .bl-hint {
    font-size: 11px;
    color: #555;
    margin-top: 8px;
    text-align: center;
  }
`;
