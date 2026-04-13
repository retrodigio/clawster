// Minimal cron expression parser supporting standard 5-field format:
// minute hour day-of-month month day-of-week
//
// Supports: exact values, wildcards, step values, ranges, lists

function matchField(field: string, value: number, max: number): boolean {
  // Handle lists: "1,3,5"
  if (field.includes(",")) {
    return field.split(",").some((part) => matchField(part.trim(), value, max));
  }

  // Handle step values: "*/15" or "1-5/2"
  if (field.includes("/")) {
    const [rangeStr, stepStr] = field.split("/");
    const step = parseInt(stepStr!, 10);
    if (isNaN(step) || step <= 0) return false;

    if (rangeStr === "*") {
      return value % step === 0;
    }

    // Range with step: "1-30/5"
    if (rangeStr!.includes("-")) {
      const [startStr, endStr] = rangeStr!.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }

    // Single value with step (unusual but valid)
    const start = parseInt(rangeStr!, 10);
    if (isNaN(start)) return false;
    return value >= start && (value - start) % step === 0;
  }

  // Handle ranges: "1-5"
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = parseInt(startStr!, 10);
    const end = parseInt(endStr!, 10);
    return value >= start && value <= end;
  }

  // Handle wildcard
  if (field === "*") return true;

  // Handle exact value
  return parseInt(field, 10) === value;
}

/**
 * Check if a Date matches a cron expression.
 * Expression format: "minute hour day-of-month month day-of-week"
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // cron months are 1-12
  const dayOfWeek = date.getDay(); // 0 = Sunday

  return (
    matchField(minuteField!, minute, 59) &&
    matchField(hourField!, hour, 23) &&
    matchField(domField!, dayOfMonth, 31) &&
    matchField(monthField!, month, 12) &&
    matchField(dowField!, dayOfWeek, 7)
  );
}

/**
 * Find the next minute after `after` that matches the cron expression.
 * Searches up to 366 days ahead to avoid infinite loops.
 */
export function getNextMatch(expression: string, after: Date): Date {
  const candidate = new Date(after);
  // Start from the next minute
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = 366 * 24 * 60; // max iterations
  for (let i = 0; i < limit; i++) {
    if (matchesCron(expression, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Fallback: should not happen with valid expressions
  return candidate;
}
