/**
 * Form prefill — the human-in-the-loop showpiece.
 *
 * The agent fills the visible fields of the real form. It never submits, never
 * clicks, and never touches a field the manifest did not declare. The human
 * reads what was filled and presses the button themselves.
 */

const HIGHLIGHT_CLASS = 'kaiju-prefilled';
const STYLE_ID = 'kaiju-prefill-style';

const STYLE = `
.${HIGHLIGHT_CLASS} {
  outline: 2px solid #c8531b;
  outline-offset: 2px;
  background-color: #fff6ef;
  transition: outline-color .4s ease, background-color .4s ease;
}
@media (prefers-color-scheme: dark) {
  .${HIGHLIGHT_CLASS} { background-color: #2a1b12; }
}
@media (prefers-reduced-motion: reduce) {
  .${HIGHLIGHT_CLASS} { transition: none; }
}`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** Locate the form element a manifest form descriptor points at. */
export function findForm(descriptor) {
  if (descriptor?.selector) {
    const el = document.querySelector(descriptor.selector);
    if (el) return el;
  }
  if (descriptor?.id) {
    const el = document.querySelector(`[data-kaiju-form="${CSS.escape(descriptor.id)}"]`);
    if (el) return el;
  }
  return null;
}

function findControl(form, field) {
  if (field.selector) {
    const el = form.querySelector(field.selector) || document.querySelector(field.selector);
    if (el) return el;
  }
  return form.querySelector(`[name="${CSS.escape(field.name)}"]`);
}

function isTruthy(value) {
  return value === true || ['true', 'yes', 'on', '1', 1].includes(value);
}

/** Set a control's value the way a person would, so page scripts still fire. */
function applyValue(control, field, value) {
  const type = (field.type || control.type || 'text').toLowerCase();

  if (type === 'checkbox') {
    control.checked = isTruthy(value);
  } else if (type === 'radio') {
    const chosen = control.form
      ? control.form.querySelector(`[name="${CSS.escape(control.name)}"][value="${CSS.escape(String(value))}"]`)
      : null;
    if (!chosen) return { ok: false, reason: `no radio option with value "${value}"` };
    chosen.checked = true;
    chosen.dispatchEvent(new Event('input', { bubbles: true }));
    chosen.dispatchEvent(new Event('change', { bubbles: true }));
    chosen.classList.add(HIGHLIGHT_CLASS);
    return { ok: true, control: chosen, applied: String(value) };
  } else if (type === 'select' || control.tagName === 'SELECT') {
    const wanted = String(value).toLowerCase();
    const option = [...control.options].find(
      (o) => o.value.toLowerCase() === wanted || o.textContent.trim().toLowerCase() === wanted
    );
    if (!option) {
      return {
        ok: false,
        reason: `"${value}" is not one of: ${[...control.options].map((o) => o.value).filter(Boolean).join(', ')}`
      };
    }
    control.value = option.value;
  } else {
    control.value = String(value);
  }

  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  control.classList.add(HIGHLIGHT_CLASS);
  return { ok: true, control, applied: type === 'checkbox' ? control.checked : control.value };
}

/** Validate a proposed value against the manifest field declaration. */
function validate(field, value) {
  if (field.enum && !field.enum.map(String).includes(String(value))) {
    return `must be one of: ${field.enum.join(', ')}`;
  }
  if (field.options && Array.isArray(field.options) && field.options.length) {
    const allowed = field.options.map((o) => String(o.value ?? o));
    if (!allowed.includes(String(value))) return `must be one of: ${allowed.join(', ')}`;
  }
  if (field.maxLength && String(value).length > field.maxLength) {
    return `exceeds maximum length of ${field.maxLength}`;
  }
  if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
    return `does not match required format (${field.pattern})`;
  }
  if ((field.type === 'number' || field.type === 'integer') && !Number.isFinite(Number(value))) {
    return 'must be a number';
  }
  return null;
}

/**
 * Fill the declared fields of a form. Returns a report the agent can read back
 * to the human — including what it deliberately did not do.
 *
 * @param {object} descriptor manifest form descriptor
 * @param {Record<string, unknown>} values
 */
export function prefill(descriptor, values = {}) {
  ensureStyle();

  const form = findForm(descriptor);
  if (!form) {
    return { ok: false, error: 'form not found on this page', formId: descriptor?.id || null };
  }

  const declared = new Map((descriptor.fields || []).map((f) => [f.name, f]));
  const filled = [];
  const rejected = [];

  for (const [name, value] of Object.entries(values)) {
    const field = declared.get(name);
    if (!field) {
      rejected.push({ name, reason: 'not a field of this form' });
      continue;
    }
    const invalid = validate(field, value);
    if (invalid) {
      rejected.push({ name, label: field.label, reason: invalid });
      continue;
    }
    const control = findControl(form, field);
    if (!control) {
      rejected.push({ name, label: field.label, reason: 'control not present in the page' });
      continue;
    }
    const applied = applyValue(control, field, value);
    if (!applied.ok) {
      rejected.push({ name, label: field.label, reason: applied.reason });
      continue;
    }
    filled.push({ name, label: field.label || name, value: applied.applied });
  }

  const stillRequired = (descriptor.fields || [])
    .filter((f) => f.required)
    .filter((f) => !filled.some((x) => x.name === f.name))
    .filter((f) => {
      const control = findControl(form, f);
      if (!control) return true;
      if ((f.type || control.type) === 'checkbox') return !control.checked;
      return !control.value;
    })
    .map((f) => ({ name: f.name, label: f.label || f.name, type: f.type || 'text' }));

  // Declared fields nobody supplied a value for and that are still empty. The
  // required ones are reported separately; these are the optional ones, and
  // saying nothing about them is how an applicant's own business name ends up
  // blank on a submitted form. The tool has the field list — it should use it.
  const notProvided = (descriptor.fields || [])
    .filter((field) => !(field.name in values))
    .filter((field) => !field.required)
    .filter((field) => {
      const control = findControl(form, field);
      if (!control) return false;
      if ((field.type || control.type) === 'checkbox') return !control.checked;
      return !control.value;
    })
    .map((field) => ({ name: field.name, label: field.label || field.name, type: field.type || 'text' }));

  if (filled.length) {
    const first = findControl(form, declared.get(filled[0].name));
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  return {
    ok: true,
    formId: descriptor.id || null,
    path: location.pathname,
    filled,
    rejected,
    stillRequired,
    notProvided,
    submitted: false,
    humanAction: stillRequired.length
      ? `${stillRequired.length} required field(s) still need a value, then the person reviews the form and presses "${descriptor.submitLabel || 'Submit'}".`
      : notProvided.length
        ? `The form has every required field. ${notProvided.length} optional field(s) were left empty because no value was supplied for them — ${notProvided.map((f) => f.label).join(', ')}. Supply them and call again if they apply, then the person reviews and presses "${descriptor.submitLabel || 'Submit'}" themselves — this tool never submits.`
        : `The form is ready. The person should review the highlighted fields and press "${descriptor.submitLabel || 'Submit'}" themselves — this tool never submits.`
  };
}
