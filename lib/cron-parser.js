// 纯 cron 解析：5 字段表达式，无副作用
function parseCronExpr(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const cron = {
    min: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4],
  };
  const specs = [
    [cron.min, 0, 59],
    [cron.hour, 0, 23],
    [cron.dom, 1, 31],
    [cron.month, 1, 12],
    [cron.dow, 0, 7],
  ];
  return specs.every(([field, min, max]) => validateCronField(field, min, max)) ? cron : null;
}

function validateCronField(field, min, max) {
  return field.split(',').every(part => {
    const pieces = part.split('/');
    if (pieces.length > 2) return false;
    const [base, rawStep] = pieces;
    if (rawStep !== undefined && (!/^\d+$/.test(rawStep) || Number(rawStep) < 1)) return false;
    if (base === '*') return true;
    if (/^\d+$/.test(base)) {
      const value = Number(base);
      return value >= min && value <= max;
    }
    const range = base.match(/^(\d+)-(\d+)$/);
    if (!range) return false;
    const start = Number(range[1]);
    const end = Number(range[2]);
    return start >= min && end <= max && start <= end;
  });
}

function nextCronTime(cron, from = new Date()) {
  const c = parseCronExpr(cron);
  if (!c) return null;
  let d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    const domMatches = matchesCronField(d.getDate(), c.dom);
    const dowMatches = matchesCronField(d.getDay(), c.dow, true);
    const dayMatches = c.dom !== '*' && c.dow !== '*' ? domMatches || dowMatches : domMatches && dowMatches;
    if (matchesCronField(d.getMinutes(), c.min) &&
        matchesCronField(d.getHours(), c.hour) &&
        dayMatches &&
        matchesCronField(d.getMonth() + 1, c.month)) {
      return d;
    }
  }
  return null;
}

function matchesCronField(val, field, sundaySeven = false) {
  const values = sundaySeven && val === 0 ? [0, 7] : [val];
  return field.split(',').some(part => {
    const [base, rawStep] = part.split('/');
    const step = rawStep ? Number(rawStep) : 1;
    if (base === '*') return values.some(value => value % step === 0);
    if (base.includes('-')) {
      const [start, end] = base.split('-').map(Number);
      return values.some(value => value >= start && value <= end && (value - start) % step === 0);
    }
    return values.includes(Number(base));
  });
}

module.exports = { parseCronExpr, validateCronField, nextCronTime, matchesCronField };
