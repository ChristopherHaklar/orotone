// Expands English abbreviations that Kokoro's G2P (misaki) reads literally, using surrounding
// context to stay unambiguous: "Nov. 12" -> "November 12", "Paul St." -> "Paul Street".
// Runs after custom pronunciations, so a user's own entry for a phrase always wins.

const MONTHS = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', jun: 'June', jul: 'July',
  aug: 'August', sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December',
};

// Only when a number follows, so "mar the finish" and "Jan said" are left alone. The period is
// dropped too, or misaki would treat it as a full stop and pause mid-date.
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?(?=\s+\d)/g;

// "Paul St." -> Street (after a capitalized word); "St. Paul" -> Saint (before one), and Saint
// wins when both fit ("Visit St. Paul"), so "St. Paul St." becomes "Saint Paul Street".
const STREET_RE = /(?<=\b[A-Z][a-z]+ )St\.(?! [A-Z])/g;
const SAINT_RE = /\bSt\.(?= [A-Z])/g;

// Inline overrides such as [Orotone](/ˈɔɹətˌOn/) are passed through untouched
const OVERRIDE_RE = /(\[[^\]]*\]\(\/[^)]*\/\))/;

export function expandAbbreviations(text) {
  const parts = text.split(OVERRIDE_RE); // odd indexes are the overrides
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(MONTH_RE, (_, m) => MONTHS[m.toLowerCase()])
      .replace(STREET_RE, 'Street')
      .replace(SAINT_RE, 'Saint');
  }
  return parts.join('');
}
