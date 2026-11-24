import { licenseCopy, PLUS_PURCHASE_URL } from './copy';
import { formatValidUntil, isRejectedLicenseKeyFormat, licensePlanLabel, maskLicenseKey, normalizeLicenseKey } from './format';
import type { LicenseStore } from './store';
import type { LicenseInfo, LicenseService, LicenseStatus, StoredLicense } from './types';

type StoredKind = LicenseStatus | 'network_error';
type Snapshot =
  | { kind: 'free' }
  | { kind: StoredKind; record: StoredLicense };

export async function mountPlusPanel(root: HTMLElement, license: {
  service: LicenseService;
  store: LicenseStore;
}): Promise<void> {
  const titleRow = document.createElement('div');
  titleRow.className = 'plus-title-row';
  const heading = document.createElement('h2');
  heading.id = 'plus-heading';
  heading.className = 'plus-title';
  heading.textContent = licenseCopy.title;
  const badge = document.createElement('span');
  badge.id = 'plus-badge';
  badge.className = 'plus-badge';
  titleRow.append(sparklesIcon(), heading, badge);

  const subtitleRow = document.createElement('p');
  subtitleRow.className = 'section-description';
  const subtitle = document.createElement('span');
  subtitle.id = 'plus-subtitle';
  subtitle.className = 'section-description';
  subtitle.textContent = licenseCopy.freeSubtitle;
  const moreDetails = document.createElement('a');
  moreDetails.href = 'https://typewith.si';
  moreDetails.target = '_blank';
  moreDetails.rel = 'noopener noreferrer';
  moreDetails.textContent = 'see more detail ↗';
  subtitleRow.append(subtitle, ' ', moreDetails);

  const form = document.createElement('div');
  form.id = 'plus-form';
  form.className = 'plus-form';
  const activateHeading = document.createElement('h3');
  activateHeading.textContent = licenseCopy.activateTitle;
  const activateDescription = document.createElement('p');
  activateDescription.className = 'section-description';
  activateDescription.textContent = licenseCopy.activateDescription;
  const keyInput = document.createElement('input');
  keyInput.id = 'license-key';
  keyInput.className = 'license-key-input';
  keyInput.type = 'text';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = 'NT-XXXX-XXXX-XXXX-XXXX-XXXX';
  keyInput.setAttribute('autocapitalize', 'off');
  keyInput.setAttribute('aria-label', licenseCopy.keyLabel);
  const keyLabel = document.createElement('label');
  keyLabel.className = 'field';
  keyLabel.htmlFor = keyInput.id;
  const keyName = document.createElement('span');
  keyName.textContent = licenseCopy.keyLabel;
  keyLabel.append(keyName, keyInput);
  const error = document.createElement('p');
  error.id = 'plus-error';
  error.className = 'plus-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const activateButton = button('activate-plus', licenseCopy.activate, 'primary');
  activateButton.disabled = true;
  const purchase = document.createElement('a');
  purchase.id = 'plus-purchase';
  purchase.className = 'plus-purchase';
  purchase.href = PLUS_PURCHASE_URL;
  purchase.target = '_blank';
  purchase.rel = 'noopener noreferrer';
  purchase.setAttribute('href', PLUS_PURCHASE_URL);
  purchase.setAttribute('target', '_blank');
  purchase.setAttribute('rel', 'noopener noreferrer');
  purchase.textContent = licenseCopy.purchase;
  const formActions = document.createElement('div');
  formActions.className = 'plus-actions';
  formActions.append(activateButton, purchase);
  form.append(activateHeading, activateDescription, keyLabel, error, formActions);

  const result = document.createElement('div');
  result.id = 'plus-result';
  result.className = 'plus-result';
  result.hidden = true;
  const message = document.createElement('p');
  message.id = 'plus-message';
  message.className = 'plus-message';
  message.setAttribute('role', 'status');
  const details = document.createElement('dl');
  details.id = 'plus-details';
  details.className = 'plus-details';
  const keyValue = document.createElement('dd');
  keyValue.id = 'plus-key-value';
  const planRow = detailRow('plus-plan-row', licenseCopy.planLabel);
  const planValue = planRow.value;
  planValue.id = 'plus-plan-value';
  const untilRow = detailRow('plus-until-row', licenseCopy.untilLabel);
  const untilValue = untilRow.value;
  untilValue.id = 'plus-until-value';
  const statusRow = detailRow('plus-status-row', licenseCopy.statusLabel);
  const statusValue = statusRow.value;
  statusValue.id = 'plus-status-value';
  details.append(
    detailRow('plus-key-row', licenseCopy.keyLabel, keyValue).row,
    planRow.row,
    untilRow.row,
    statusRow.row,
  );
  const refreshButton = button('refresh-license', licenseCopy.refresh, 'secondary');
  const removeButton = button('remove-license', licenseCopy.remove, 'secondary');
  const resultActions = document.createElement('div');
  resultActions.className = 'plus-actions';
  resultActions.append(refreshButton, removeButton);
  result.append(message, details, resultActions);

  root.className = 'plus';
  root.setAttribute('aria-labelledby', heading.id);
  root.append(titleRow, subtitleRow, form, result);

  let generation = 0;
  let submitting = false;
  let snapshot: Snapshot = { kind: 'free' };

  keyInput.addEventListener('input', () => {
    if (submitting) return;
    activateButton.disabled = keyInput.value.trim() === '';
    if (!error.hidden) clearError();
  });
  keyInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void activate();
  });
  activateButton.addEventListener('click', () => activate());
  refreshButton.addEventListener('click', () => {
    if (snapshot.kind === 'free' || submitting) return;
    const ticket = ++generation;
    return revalidate(snapshot.record, ticket);
  });
  removeButton.addEventListener('click', () => removeKey());

  hideBadge();
  form.hidden = true;
  root.dataset.state = 'loading';
  let stored: StoredLicense | null = null;
  try {
    stored = await license.store.load();
  } catch {
    showFree();
    return;
  }
  if (!stored) {
    showFree();
    return;
  }
  await revalidate(stored, ++generation);

  function problemCopy(kind: Exclude<StoredKind, 'active' | 'expired'>): string {
    const messages = {
      invalid: licenseCopy.invalid,
      revoked: licenseCopy.revoked,
      access_revoked: licenseCopy.accessRevoked,
      inactive: licenseCopy.inactive,
      none: licenseCopy.noAccess,
      network_error: licenseCopy.network,
    };
    return messages[kind];
  }

  function statusLabel(kind: StoredKind): string {
    const labels = {
      active: licenseCopy.activeStatus,
      expired: licenseCopy.expiredStatus,
      revoked: licenseCopy.revokedStatus,
      access_revoked: licenseCopy.accessRevokedStatus,
      inactive: licenseCopy.inactiveStatus,
      none: licenseCopy.noAccessStatus,
      invalid: licenseCopy.invalidStatus,
      network_error: licenseCopy.networkStatus,
    };
    return labels[kind];
  }

  function setBadge(state: string, text: string) {
    badge.hidden = false;
    badge.dataset.state = state;
    badge.textContent = text;
  }

  function hideBadge() {
    badge.hidden = true;
    badge.textContent = '';
  }

  function clearError() {
    error.hidden = true;
    error.textContent = '';
    keyInput.setAttribute('aria-invalid', 'false');
  }

  function showFormError(text: string) {
    error.hidden = false;
    error.textContent = text;
    keyInput.setAttribute('aria-invalid', 'true');
    if (text === licenseCopy.revoked) root.dataset.state = 'revoked';
    else if (text === licenseCopy.invalid) root.dataset.state = 'invalid';
    else if (snapshot.kind === 'free') root.dataset.state = 'free';
    else root.dataset.state = 'network_error';
  }

  function clearKeyField() {
    keyInput.value = '';
    activateButton.disabled = true;
  }

  function showFree() {
    snapshot = { kind: 'free' };
    root.dataset.state = 'free';
    setBadge('free', licenseCopy.freeStatus);
    subtitle.textContent = licenseCopy.freeSubtitle;
    form.hidden = false;
    result.hidden = true;
    clearError();
    keyInput.disabled = false;
    clearKeyField();
    activateButton.textContent = licenseCopy.activate;
    submitting = false;
  }

  function showChecking() {
    root.dataset.state = 'verifying';
    hideBadge();
    subtitle.textContent = licenseCopy.freeSubtitle;
    form.hidden = true;
    result.hidden = false;
    details.hidden = true;
    message.hidden = false;
    message.dataset.tone = 'neutral';
    message.textContent = licenseCopy.checking;
    refreshButton.hidden = true;
    removeButton.hidden = true;
    clearKeyField();
  }

  function showStored(kind: StoredKind, record: StoredLicense) {
    snapshot = { kind, record };
    root.dataset.state = kind;
    if (kind === 'active') setBadge('active', licenseCopy.activeStatus);
    else if (kind === 'expired') setBadge('expired', licenseCopy.expiredStatus);
    else hideBadge();
    subtitle.textContent = kind === 'active' ? licenseCopy.activeSubtitle : licenseCopy.freeSubtitle;
    form.hidden = true;
    result.hidden = false;
    const problem = kind !== 'active' && kind !== 'expired';
    message.hidden = !problem;
    message.dataset.tone = problem ? 'error' : 'neutral';
    message.textContent = problem ? problemCopy(kind) : '';
    details.hidden = false;
    keyValue.textContent = maskLicenseKey(record.licenseKey);
    const plan = licensePlanLabel(record.lastVerification?.plan);
    planRow.row.hidden = !plan;
    planValue.textContent = plan ?? '';
    const until = formatValidUntil(record.lastVerification?.validUntil);
    untilRow.row.hidden = !until;
    untilValue.textContent = until ?? '';
    statusValue.textContent = statusLabel(kind);
    refreshButton.hidden = false;
    refreshButton.disabled = false;
    removeButton.hidden = false;
    clearKeyField();
    keyInput.disabled = false;
    submitting = false;
  }

  async function revalidate(record: StoredLicense, ticket: number) {
    showChecking();
    try {
      const info = await license.service.validate(record.licenseKey);
      if (ticket !== generation) return;
      const next = verifiedRecord(record.licenseKey, info);
      try {
        const updated = await license.store.updateVerification(next);
        if (ticket !== generation) return;
        if (!updated) {
          const current = await license.store.load();
          if (ticket !== generation) return;
          if (current) await revalidate(current, ticket);
          else showFree();
          return;
        }
      } catch {
        if (ticket !== generation) return;
        showStored('network_error', record);
        return;
      }
      if (ticket !== generation) return;
      showStored(info.status, next);
    } catch {
      if (ticket !== generation) return;
      showStored('network_error', record);
    }
  }

  async function removeKey() {
    if (snapshot.kind === 'free' || submitting) return;
    const ticket = ++generation;
    const record = snapshot.record;
    try {
      await license.store.remove();
    } catch {
      if (ticket !== generation) return;
      showStored('network_error', record);
      return;
    }
    if (ticket !== generation) return;
    showFree();
  }

  async function activate() {
    if (submitting || activateButton.disabled) return;
    const typed = keyInput.value.trim();
    if (!typed) return;
    if (isRejectedLicenseKeyFormat(typed)) {
      showFormError(licenseCopy.invalid);
      return;
    }
    const licenseKey = normalizeLicenseKey(typed) ?? typed;
    const ticket = ++generation;
    submitting = true;
    root.dataset.state = 'verifying';
    keyInput.disabled = true;
    activateButton.disabled = true;
    activateButton.textContent = licenseCopy.activating;
    clearError();
    try {
      const [revision, info] = await Promise.all([
        license.store.revision(),
        license.service.validate(licenseKey),
      ]);
      if (ticket !== generation) return;
      if (info.status === 'invalid' || info.status === 'revoked') {
        showFormError(problemCopy(info.status));
        return;
      }
      const record = verifiedRecord(licenseKey, info);
      try {
        const saved = await license.store.save(record, revision);
        if (ticket !== generation) return;
        if (!saved) {
          const current = await license.store.load();
          if (ticket !== generation) return;
          if (current) await revalidate(current, ticket);
          else showFree();
          return;
        }
      } catch {
        if (ticket !== generation) return;
        showFormError(licenseCopy.network);
        return;
      }
      if (ticket !== generation) return;
      showStored(info.status, record);
    } catch {
      if (ticket !== generation) return;
      showFormError(licenseCopy.network);
    } finally {
      if (ticket !== generation) return;
      submitting = false;
      if (!form.hidden) {
        keyInput.disabled = false;
        activateButton.textContent = licenseCopy.activate;
        activateButton.disabled = keyInput.value.trim() === '';
      }
    }
  }
}

function verifiedRecord(licenseKey: string, info: LicenseInfo): StoredLicense {
  const lastVerification: NonNullable<StoredLicense['lastVerification']> = { status: info.status };
  if (info.plan) lastVerification.plan = info.plan;
  if (info.validUntil !== undefined) lastVerification.validUntil = info.validUntil;
  return {
    licenseKey,
    lastVerifiedAt: new Date().toISOString(),
    lastVerification,
  };
}

function button(id: string, text: string, kind: 'primary' | 'secondary'): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.id = id;
  control.className = kind;
  control.textContent = text;
  return control;
}

function detailRow(id: string, label: string, value = document.createElement('dd')): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement('div');
  row.id = id;
  const term = document.createElement('dt');
  term.textContent = label;
  row.append(term, value);
  return { row, value };
}

function sparklesIcon(): SVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  const large = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  large.setAttribute('d', 'M12 2.6 13.5 7.8 18.7 9.3 13.5 10.8 12 16 10.5 10.8 5.3 9.3 10.5 7.8 12 2.6Z');
  const small = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  small.setAttribute('d', 'M18 13.4 18.8 15.8 21.2 16.6 18.8 17.4 18 19.8 17.2 17.4 14.8 16.6 17.2 15.8 18 13.4Z');
  icon.append(large, small);
  return icon;
}
