import { describeLanguagePair } from '../languages/config';
import { languageOptionLabel, translatorLanguages } from '../languages/catalog';
import { platformContextConfig } from './config';
import { getDefaultSettings, normalizeSettings, sameSettings, type NativeTypeSettings, type SettingsStore } from './store';

const languages = [...translatorLanguages].sort((left, right) => left.englishName.localeCompare(right.englishName));

export async function mountSettingsPage(root: HTMLElement, store: SettingsStore, iconUrl: string, version?: string): Promise<HTMLElement> {
  const sourceSelect = document.createElement('select');
  const targetSelect = document.createElement('select');
  sourceSelect.id = 'source-language';
  targetSelect.id = 'target-language';
  const modeInputs = (['manual', 'automatic'] as const).map(mode => {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'translation-mode';
    input.id = `translation-mode-${mode}`;
    input.value = mode;
    return input;
  });
  const analyticsInput = switchInput('analytics-enabled');
  const contextGroups = Object.entries(platformContextConfig).map(([platform, config]) => ({
    platform,
    title: config.title,
    defaultOpen: config.defaultOpen,
    inputs: Object.entries(config.contexts).map(([context, option]) => ({
      context,
      input: switchInput(option.inputId),
      label: option.label,
      hint: option.hint,
      defaultEnabled: option.defaultEnabled,
    })),
  }));
  const direction = document.createElement('p');
  direction.className = 'direction';
  direction.id = 'translation-direction';
  direction.setAttribute('aria-live', 'polite');
  const status = document.createElement('p');
  status.className = 'save-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  let rendering = false;
  let lastSaved = getDefaultSettings();
  let pending: NativeTypeSettings | undefined;
  let saving = false;
  let revision = 0;
  let storageRevision = 0;

  const general = document.createElement('div');
  const plus = document.createElement('div');
  root.append(brand(iconUrl, version), settingsTabs(general, plus), general, plus);
  general.append(
    translationSection(sourceSelect, targetSelect, direction),
    divider(),
    translationModeSection(modeInputs),
    divider(),
    contextSection(contextGroups),
    analyticsSection(analyticsInput),
    footer(status),
  );
  render(lastSaved);

  for (const select of [sourceSelect, targetSelect]) {
    select.addEventListener('change', () => {
      if (rendering) return;
      if (sourceSelect.value === targetSelect.value) {
        const selectChanged = select === sourceSelect ? targetSelect : sourceSelect;
        const alternate = languages.find(language => language.code !== select.value);
        if (alternate) selectChanged.value = alternate.code;
      }
      syncOptions();
      updateDirection();
      persist();
    });
  }
  for (const { input } of contextGroups.flatMap(group => group.inputs)) {
    input.addEventListener('change', () => {
      if (!rendering) persist();
    });
  }
  for (const input of modeInputs) {
    input.addEventListener('change', () => {
      if (!rendering && input.checked) persist();
    });
  }
  analyticsInput.addEventListener('change', () => {
    if (!rendering) persist();
  });

  store.subscribe(next => {
    revision += 1;
    storageRevision += 1;
    lastSaved = next;
    // A storage echo must not replace a newer edit that is still being saved.
    if (saving || pending) return;
    render(next);
    setStatus('Saved');
  });

  const loadRevision = revision;
  try {
    const loaded = await store.load();
    if (revision !== loadRevision) return general;
    render(loaded);
    lastSaved = loaded;
    setStatus('Saved');
  } catch {
    if (revision !== loadRevision) return general;
    setStatus('Couldn’t load settings. Changes will be kept on this page until saving works.');
  }

  function readForm(): NativeTypeSettings {
    return normalizeSettings({
      schemaVersion: 1,
      analytics: { enabled: analyticsInput.checked },
      translation: {
        mode: modeInputs.find(input => input.checked)?.value,
        sourceLanguage: sourceSelect.value,
        targetLanguage: targetSelect.value,
      },
      contexts: Object.fromEntries(contextGroups.map(group => [
        group.platform,
        Object.fromEntries(group.inputs.map(({ context, input }) => [context, input.checked])),
      ])),
    });
  }

  function render(settings: NativeTypeSettings) {
    rendering = true;
    analyticsInput.checked = settings.analytics.enabled;
    for (const input of modeInputs) input.checked = input.value === settings.translation.mode;
    fill(sourceSelect, settings.translation.sourceLanguage, settings.translation.targetLanguage);
    fill(targetSelect, settings.translation.targetLanguage, settings.translation.sourceLanguage);
    const contexts: Record<string, Record<string, boolean>> = settings.contexts;
    for (const group of contextGroups) {
      for (const { context, input, defaultEnabled } of group.inputs) {
        input.checked = contexts[group.platform]?.[context] ?? defaultEnabled;
      }
    }
    updateDirection();
    rendering = false;
  }

  function syncOptions() {
    fill(sourceSelect, sourceSelect.value, targetSelect.value);
    fill(targetSelect, targetSelect.value, sourceSelect.value);
  }

  function updateDirection() {
    direction.textContent = describeLanguagePair({
      source: sourceSelect.value,
      target: targetSelect.value,
    });
  }

  function setStatus(text: string) {
    status.textContent = text;
    status.dataset.state = text === 'Saved' ? 'saved' : text === 'Saving…' ? 'saving' : 'error';
  }

  function persist() {
    revision += 1;
    pending = readForm();
    void flush();
  }

  async function flush() {
    if (saving) return;
    saving = true;
    try {
      while (pending) {
        const next = pending;
        pending = undefined;
        if (sameSettings(next, lastSaved)) continue;
        setStatus('Saving…');
        const savedRevision = storageRevision;
        try {
          await store.save(next);
          if (storageRevision === savedRevision) lastSaved = next;
        } catch {
          if (pending) continue;
          pending = next;
          setStatus('Couldn’t save settings.');
          return;
        }
      }
      setStatus('Saved');
    } finally {
      saving = false;
    }
  }

  return general;
}

function settingsTabs(general: HTMLElement, plus: HTMLElement): HTMLElement {
  general.id = 'settings-general';
  plus.id = 'settings-plus';
  general.setAttribute('role', 'tabpanel');
  plus.setAttribute('role', 'tabpanel');
  general.setAttribute('aria-labelledby', 'tab-general');
  plus.setAttribute('aria-labelledby', 'tab-plus');
  plus.hidden = true;

  const generalTab = tabButton('tab-general', 'General', general.id);
  const plusTab = tabButton('tab-plus', 'Plus', plus.id);
  const tabs = [generalTab, plusTab];
  const panels = [general, plus];
  generalTab.setAttribute('aria-selected', 'true');
  plusTab.setAttribute('aria-selected', 'false');
  plusTab.tabIndex = -1;

  function select(index: number) {
    tabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
      const panel = panels[tabIndex];
      if (panel) panel.hidden = !selected;
    });
  }

  generalTab.addEventListener('click', () => select(0));
  plusTab.addEventListener('click', () => select(1));
  const nav = document.createElement('div');
  nav.className = 'settings-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Settings');
  nav.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const current = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
    const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    select(next);
    tabs[next]?.focus();
  });
  nav.append(generalTab, plusTab);
  return nav;
}

function tabButton(id: string, label: string, panelId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.className = 'settings-tab';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', panelId);
  button.textContent = label;
  return button;
}

function brand(iconUrl: string, version?: string): HTMLElement {
  const header = document.createElement('header');
  header.className = 'brand';
  const icon = document.createElement('img');
  icon.src = iconUrl;
  icon.width = 48;
  icon.height = 48;
  icon.alt = '';
  const title = document.createElement('h1');
  title.textContent = 'NativeType';
  const slogan = document.createElement('p');
  slogan.textContent = 'Write in your language. Publish in another.';
  header.append(icon, title, slogan);
  if (version) {
    const versionLabel = document.createElement('p');
    versionLabel.className = 'brand-version';
    versionLabel.textContent = `v${version}`;
    header.append(versionLabel);
  }
  return header;
}

function translationSection(sourceSelect: HTMLSelectElement, targetSelect: HTMLSelectElement, direction: HTMLElement): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('aria-labelledby', 'translation-heading');
  const heading = document.createElement('h2');
  heading.id = 'translation-heading';
  heading.textContent = 'Translation';
  const description = document.createElement('p');
  description.className = 'section-description';
  description.textContent = 'Choose when and how your text is translated.';
  const languageFields = document.createElement('div');
  languageFields.className = 'translation-fields';
  languageFields.append(
    field('When I write in', sourceSelect),
    field('Translate to', targetSelect),
  );
  section.append(
    heading,
    description,
    languageFields,
    direction,
  );
  return section;
}

function translationModeSection(inputs: HTMLInputElement[]): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('aria-labelledby', 'translation-mode-heading');
  const heading = document.createElement('h2');
  heading.id = 'translation-mode-heading';
  heading.textContent = 'Translation Mode';
  const group = document.createElement('div');
  group.className = 'translation-modes';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', heading.id);
  for (const input of inputs) {
    const label = document.createElement('label');
    label.className = 'translation-mode';
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = input.value === 'manual' ? 'Manual' : 'Automatic';
    const description = document.createElement('span');
    description.className = 'mode-description';
    description.textContent = input.value === 'manual' ? 'Translate only when you ask.' : 'Automatically translate as you write.';
    copy.append(title, description);
    label.append(input, copy);
    group.append(label);
  }
  section.append(heading, group);
  return section;
}

interface ContextGroup {
  platform: string;
  title: string;
  defaultOpen: boolean;
  inputs: { input: HTMLInputElement; label: string; hint: string }[];
}

function contextSection(groups: ContextGroup[]): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('aria-labelledby', 'contexts-heading');
  const heading = document.createElement('h2');
  heading.id = 'contexts-heading';
  heading.textContent = 'Where NativeType works';
  const description = document.createElement('p');
  description.className = 'section-description';
  description.textContent = 'Choose where translation is enabled.';
  section.append(heading, description);
  for (const group of groups) {
    const collapse = document.createElement('details');
    collapse.className = 'context-group';
    collapse.open = group.defaultOpen;
    const summary = document.createElement('summary');
    summary.className = 'context-summary';
    const chevron = document.createElement('span');
    chevron.className = 'context-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.textContent = group.title;
    summary.append(chevron, title);
    const content = document.createElement('div');
    content.className = 'context-options';
    content.id = `contexts-${group.platform}`;
    summary.setAttribute('aria-controls', content.id);
    content.append(...group.inputs.map(({ input, label, hint }) => contextRow(input, label, hint)));
    collapse.append(summary, content);
    section.append(collapse);
  }
  return section;
}

function field(labelText: string, select: HTMLSelectElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'field';
  const name = document.createElement('span');
  name.textContent = labelText;
  select.setAttribute('autocomplete', 'off');
  label.append(name, select);
  return label;
}

function analyticsSection(input: HTMLInputElement): HTMLElement {
  const section = document.createElement('section');
  section.className = 'analytics-section';
  section.setAttribute('aria-labelledby', 'privacy-heading');
  const heading = document.createElement('h2');
  heading.id = 'privacy-heading';
  heading.textContent = 'Privacy & Analytics';
  const description = document.createElement('p');
  description.className = 'section-description';
  description.textContent = 'Optional. Disabled by default.';
  const details = document.createElement('p');
  details.className = 'section-description';
  details.textContent = 'Turning this on immediately sends an analytics-enabled event with a random installation ID. Subsequent usage counts go to NativeType’s Cloudflare Worker. The server stores a keyed hash of the ID with daily counts for 90 UTC dates. Turning this off clears the local ID and stops reporting; historical counts remain until they expire. Enabling again creates a new ID.';
  section.append(heading, description, contextRow(input, 'Share anonymous usage statistics',
    'Help improve NativeType by sharing anonymous counts of successful translations, replacements (including AI replacements), and errors. Statistics never include your text, translations, URLs, or account information.'), details);
  return section;
}

function contextRow(input: HTMLInputElement, title: string, hint: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'context';
  const copy = document.createElement('div');
  const label = document.createElement('label');
  label.htmlFor = input.id;
  label.textContent = title;
  const description = document.createElement('p');
  description.id = `${input.id}-hint`;
  description.textContent = hint;
  input.setAttribute('aria-describedby', description.id);
  copy.append(label, description);
  const widget = document.createElement('span');
  widget.className = 'switch';
  const track = document.createElement('span');
  track.className = 'track';
  track.setAttribute('aria-hidden', 'true');
  widget.append(input, track);
  row.append(copy, widget);
  return row;
}

function switchInput(id: string): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  return input;
}

function divider(): HTMLElement {
  const line = document.createElement('hr');
  return line;
}

function footer(status: HTMLElement): HTMLElement {
  const bar = document.createElement('footer');
  const info = document.createElement('div');
  info.className = 'footer-info';
  const name = document.createElement('p');
  name.textContent = 'NativeType Settings';
  const github = document.createElement('a');
  github.textContent = 'GitHub';
  github.href = 'https://github.com/webszy/nativeType-open';
  github.target = '_blank';
  github.rel = 'noopener noreferrer';
  info.append(name, github);
  bar.append(info, status);
  return bar;
}

function fill(select: HTMLSelectElement, selected: string, blocked: string): void {
  const current = [...select.options].map(option => `${option.value}:${option.disabled}`).join('|');
  const next = languages.map(language => `${language.code}:${language.code === blocked}`).join('|');
  if (select.value === selected && current === next && select.options.length === languages.length) return;
  select.replaceChildren();
  for (const language of languages) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = languageOptionLabel(language.code);
    option.disabled = language.code === blocked;
    select.append(option);
  }
  select.value = selected;
}
