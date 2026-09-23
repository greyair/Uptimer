import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { useI18n } from '../app/I18nContext';
import {
  Button,
  FIELD_HELP_CLASS,
  INPUT_CLASS,
  MODAL_OVERLAY_CLASS,
  MODAL_PANEL_CLASS,
} from './ui';

const COMMON_GLOBALPING_SELECTORS = [
  'Tokyo',
  'Singapore',
  'Hong Kong',
  'Los Angeles',
  'New York',
  'Frankfurt',
  'London',
  'Sydney',
] as const;

type GlobalpingLocationPickerProps = {
  value: string[];
  onChange: (value: string[]) => void;
  maxSelections?: number;
};

function includesSelector(values: string[], selector: string): boolean {
  const normalized = selector.trim().toLocaleLowerCase();
  return values.some((value) => value.trim().toLocaleLowerCase() === normalized);
}

export function GlobalpingLocationPicker({
  value,
  onChange,
  maxSelections = 10,
}: GlobalpingLocationPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [customSelector, setCustomSelector] = useState('');

  const visibleCommonSelectors = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return COMMON_GLOBALPING_SELECTORS;
    return COMMON_GLOBALPING_SELECTORS.filter((selector) =>
      selector.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  const openPicker = () => {
    setDraft([...value]);
    setQuery('');
    setCustomSelector('');
    setOpen(true);
  };

  const closePicker = () => {
    setOpen(false);
    setQuery('');
    setCustomSelector('');
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        setQuery('');
        setCustomSelector('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const toggleSelector = (selector: string) => {
    setDraft((current) => {
      const index = current.findIndex(
        (item) => item.trim().toLocaleLowerCase() === selector.trim().toLocaleLowerCase(),
      );
      if (index >= 0) {
        return current.filter((_, itemIndex) => itemIndex !== index);
      }
      if (current.length >= maxSelections) return current;
      return [...current, selector];
    });
  };

  const addCustomSelector = () => {
    const normalized = customSelector.trim();
    if (!normalized || draft.length >= maxSelections || includesSelector(draft, normalized)) return;
    setDraft((current) => [...current, normalized]);
    setCustomSelector('');
  };

  const confirmSelection = () => {
    onChange(draft.map((item) => item.trim()).filter(Boolean).slice(0, maxSelections));
    closePicker();
  };

  const removeSelected = (index: number) => {
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  };

  const visibleSelected = value.slice(0, 3);
  const hiddenCount = Math.max(0, value.length - visibleSelected.length);

  const dialog =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className={MODAL_OVERLAY_CLASS}
            style={{ zIndex: 60 }}
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closePicker();
            }}
          >
            <div
              className={`${MODAL_PANEL_CLASS} sm:max-w-lg p-5 sm:p-6`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="globalping-location-picker-title"
            >
              <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                  <h2
                    id="globalping-location-picker-title"
                    className="text-xl font-semibold text-slate-900 dark:text-slate-100"
                  >
                    {t('monitor_form.globalping_locations')}
                  </h2>
                  <div className={FIELD_HELP_CLASS}>
                    {t('monitor_form.globalping_picker_limit', { count: maxSelections })}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {t('monitor_form.globalping_picker_selected_count', {
                    count: draft.length,
                    max: maxSelections,
                  })}
                </span>
              </div>

              <div className="space-y-5">
                {draft.length > 0 && (
                  <div>
                    <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                      {t('monitor_form.globalping_picker_selected')}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {draft.map((selector, index) => (
                        <button
                          key={`${selector}-${index}`}
                          type="button"
                          onClick={() =>
                            setDraft((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                          aria-label={t('monitor_form.globalping_picker_remove', {
                            value: selector,
                          })}
                        >
                          <span>{selector}</span>
                          <span aria-hidden="true">×</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                    {t('monitor_form.globalping_picker_search')}
                  </label>
                  <input
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className={INPUT_CLASS}
                    placeholder={t('monitor_form.globalping_picker_search_placeholder')}
                    autoFocus
                  />
                </div>

                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                    {t('monitor_form.globalping_picker_common')}
                  </div>
                  {visibleCommonSelectors.length > 0 ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {visibleCommonSelectors.map((selector) => {
                        const checked = includesSelector(draft, selector);
                        const disabled = !checked && draft.length >= maxSelections;
                        return (
                          <label
                            key={selector}
                            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleSelector(selector)}
                            />
                            <span>{selector}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={FIELD_HELP_CLASS}>
                      {t('monitor_form.globalping_picker_no_matches')}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                    {t('monitor_form.globalping_picker_custom')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={customSelector}
                      onChange={(event) => setCustomSelector(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addCustomSelector();
                        }
                      }}
                      className={INPUT_CLASS}
                      placeholder={t('monitor_form.globalping_picker_custom_placeholder')}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={addCustomSelector}
                      disabled={
                        !customSelector.trim() ||
                        draft.length >= maxSelections ||
                        includesSelector(draft, customSelector)
                      }
                    >
                      {t('monitor_form.globalping_picker_add')}
                    </Button>
                  </div>
                  <div className={FIELD_HELP_CLASS}>
                    {t('monitor_form.globalping_picker_custom_help')}
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
                <Button type="button" variant="secondary" onClick={closePicker}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" onClick={confirmSelection}>
                  {t('monitor_form.globalping_picker_confirm')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/30">
        <div className="flex flex-wrap items-center gap-2">
          {visibleSelected.map((selector, index) => (
            <span
              key={`${selector}-${index}`}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            >
              <span>{selector}</span>
              <button
                type="button"
                onClick={() => removeSelected(index)}
                className="rounded-full px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                aria-label={t('monitor_form.globalping_picker_remove', { value: selector })}
              >
                ×
              </button>
            </span>
          ))}
          {hiddenCount > 0 && (
            <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
              +{hiddenCount}
            </span>
          )}
          {value.length === 0 && (
            <span className="text-sm text-slate-400 dark:text-slate-500">
              {t('monitor_form.globalping_picker_none_selected')}
            </span>
          )}
        </div>
        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" onClick={openPicker}>
            {t('monitor_form.globalping_picker_select')}
          </Button>
        </div>
      </div>
      <div className={FIELD_HELP_CLASS}>{t('monitor_form.globalping_locations_help')}</div>
      {dialog}
    </>
  );
}
