/* A single, exact contract address shared by every Sona copy control. */
(() => {
  const address = 'XXLrHxzRkrSrwfQWrLDKjKw2Y2AtnbyUyQdfjgCpump';
  const copyIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M15.5 4H6.5A2.5 2.5 0 0 0 4 6.5v9"/></svg>';
  const checkIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';

  function copyWithSelection() {
    const active = document.activeElement;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const fieldSelection = active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection]
      : null;
    const field = document.createElement('textarea');
    field.value = address;
    field.readOnly = true;
    field.tabIndex = -1;
    field.setAttribute('aria-hidden', 'true');
    field.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
    document.body.append(field);
    let copied = false;
    try {
      field.select();
      field.setSelectionRange(0, address.length);
      copied = document.execCommand('copy') === true;
    } catch (_) {
      copied = false;
    } finally {
      field.remove();
      if (active instanceof HTMLElement && active.isConnected) {
        active.focus({ preventScroll: true });
        if (fieldSelection && typeof active.setSelectionRange === 'function') {
          active.setSelectionRange(...fieldSelection);
        }
      }
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach(range => selection.addRange(range));
      }
    }
    return copied;
  }

  class SonaContract extends HTMLElement {
    connectedCallback() {
      if (this.initialized) return;
      this.initialized = true;
      const compact = this.getAttribute('variant') === 'compact';
      this.innerHTML = `
        <button class="sona-contract__button" type="button" aria-label="Copy Sona contract address ${address}" title="Copy contract address">
          <span class="sona-contract__label">
            <span class="sona-contract__ready">${compact ? 'CA' : 'Contract address'}</span>
            <span class="sona-contract__copied" aria-hidden="true">Copied</span>
          </span>
          <span class="sona-contract__address" aria-hidden="true">${compact ? `${address.slice(0, 6)}…${address.slice(-6)}` : `${address.slice(0, 20)}<wbr>${address.slice(20)}`}</span>
          <span class="sona-contract__icons"><span class="sona-contract__ready">${copyIcon}</span><span class="sona-contract__copied">${checkIcon}</span></span>
        </button>
        <span class="sona-contract__status" role="status" aria-live="polite" aria-atomic="true"></span>
        <label class="sona-contract__manual" hidden>
          <span>Copy this address</span>
          <textarea class="sona-contract__selection" rows="2" readonly spellcheck="false" aria-label="Sona contract address; select and copy">${address}</textarea>
        </label>`;
      this.button = this.querySelector('.sona-contract__button');
      this.status = this.querySelector('.sona-contract__status');
      this.manual = this.querySelector('.sona-contract__manual');
      this.selection = this.querySelector('.sona-contract__selection');
      this.button.addEventListener('click', () => this.copyAddress());
      this.selection.addEventListener('focus', () => this.selection.select());
      this.selection.addEventListener('click', () => this.selection.select());
    }

    disconnectedCallback() {
      window.clearTimeout(this.resetTimer);
      this.removeAttribute('data-copied');
    }

    async copyAddress() {
      if (this.copying) return;
      this.copying = true;
      this.status.textContent = '';
      window.clearTimeout(this.resetTimer);
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(address);
          copied = true;
        }
      } catch (_) {
        // Some browsers disallow clipboard access. A selection is the fallback.
      }
      if (!copied) copied = copyWithSelection();
      this.copying = false;
      if (!this.isConnected) return;
      if (copied) {
        this.manual.hidden = true;
        this.setAttribute('data-copied', 'true');
        this.status.textContent = 'Contract address copied.';
        this.resetTimer = window.setTimeout(() => this.removeAttribute('data-copied'), 2200);
      } else {
        this.removeAttribute('data-copied');
        this.manual.hidden = false;
        this.status.textContent = 'Clipboard access is unavailable. Select and copy the address below.';
        this.selection.focus({ preventScroll: true });
        this.selection.select();
      }
    }
  }

  if (!customElements.get('sona-contract')) customElements.define('sona-contract', SonaContract);
})();
