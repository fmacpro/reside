/**
 * Get the current system date and/or time.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createGetCurrentTimeHandler(engine) {
  return async ({ format }) => {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const unixTs = Math.floor(now.getTime() / 1000);

    // Build structured data regardless of format requested
    const data = {
      datetime: now.toISOString(),
      date: now.toISOString().split('T')[0],
      time: now.toTimeString().split(' ')[0],
      timezone,
      unixTimestamp: unixTs,
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      monthName: now.toLocaleString('en-GB', { month: 'long' }),
      day: now.getDate(),
      dayOfWeek: now.toLocaleString('en-GB', { weekday: 'long' }),
    };

    // Determine output based on format parameter
    let output;
    switch (format) {
      case 'date':
        output = data.date;
        break;
      case 'time':
        output = data.time;
        break;
      case 'day':
        output = data.dayOfWeek;
        break;
      case 'month':
        output = data.monthName;
        break;
      case 'year':
        output = String(data.year);
        break;
      case 'timestamp':
        output = String(unixTs);
        break;
      case 'full':
      default: {
        const formatter = new Intl.DateTimeFormat('en-GB', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          timeZoneName: 'long',
        });
        output = `${formatter.format(now)} (${timezone}, unix: ${unixTs})`;
        break;
      }
    }

    return { success: true, output, data };
  };
}
