// Netlify Function: /.netlify/functions/availability?property=<id>
// Fetches iCal feeds from Airbnb / Booking.com etc., merges them, and
// returns blocked date ranges so the website calendar never shows a
// date that's already booked on another platform.
//
// SETUP: in Netlify → Site settings → Environment variables, add one
// variable per property, named ICAL_<PROPERTY_ID_UPPERCASE_WITH_UNDERSCORES>
// containing one or more iCal URLs separated by commas. Example:
//
//   ICAL_VILLA_PHASE6 = https://www.airbnb.com/calendar/ical/12345.ics?s=abc, https://ical.booking.com/v1/export?t=xyz
//
// Property ids come from the PROPERTIES config in the website
// ("villa-phase6" → ICAL_VILLA_PHASE6).

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    // cache at the CDN for 10 minutes so repeated visitors don't hammer Airbnb
    "Cache-Control": "public, max-age=600",
  };

  const property = (event.queryStringParameters || {}).property || "";
  if (!/^[a-z0-9-]+$/i.test(property)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid property" }) };
  }

  const envKey = "ICAL_" + property.toUpperCase().replace(/-/g, "_");
  const urls = (process.env[envKey] || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    // No feeds configured yet → treat everything as available
    return { statusCode: 200, headers, body: JSON.stringify({ blocked: [], note: "no feeds configured for " + envKey }) };
  }

  const blocked = [];
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "NesteraBookingSync/1.0" } });
        if (!res.ok) return;
        const text = await res.text();
        for (const range of parseICal(text)) blocked.push(range);
      } catch (_) {
        /* one bad feed shouldn't break the calendar */
      }
    })
  );

  return { statusCode: 200, headers, body: JSON.stringify({ blocked: mergeRanges(blocked) }) };
};

// Minimal iCal parser: extracts DTSTART/DTEND from each VEVENT.
// Airbnb & Booking.com export all-day busy blocks (DTEND is exclusive,
// i.e., the checkout day — which matches how the website calendar
// treats `end`).
function parseICal(text) {
  const ranges = [];
  // unfold folded lines (RFC 5545: continuation lines start with space/tab)
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = unfolded.split("BEGIN:VEVENT").slice(1);
  for (const ev of events) {
    const start = matchDate(ev, "DTSTART");
    const end = matchDate(ev, "DTEND");
    if (start && end) ranges.push({ start, end });
  }
  return ranges;
}

function matchDate(block, key) {
  const m = block.match(new RegExp(key + "[^:]*:([0-9]{8})"));
  if (!m) return null;
  return m[1].slice(0, 4) + "-" + m[1].slice(4, 6) + "-" + m[1].slice(6, 8);
}

// Merge overlapping/adjacent ranges to keep the payload small.
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => (a.start < b.start ? -1 : 1));
  const out = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    if (ranges[i].start <= last.end) {
      if (ranges[i].end > last.end) last.end = ranges[i].end;
    } else {
      out.push(ranges[i]);
    }
  }
  return out;
}
