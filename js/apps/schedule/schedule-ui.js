/**
 * ScheduleUI — the formatters the old Tasks list shared (time, time range,
 * relative date, repeat and reminder labels). The list and editor rendering
 * went with the Tasks page (2026-10-05, docs/COMMITMENTS.md phase 5b);
 * link-picker and the Today widget still read these.
 */
const ScheduleUI = {
    formatTime(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return '';
        const parts = timeStr.split(':').map(Number);
        const h = parts[0];
        const m = Number.isFinite(parts[1]) ? parts[1] : 0;
        if (!Number.isFinite(h)) return '';
        const period = h >= 12 ? 'PM' : 'AM';
        const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
    },

    formatTimeRange(startTime, endTime) {
        const start = this.formatTime(startTime);
        const end = this.formatTime(endTime);
        if (!end) return start;
        if (!start) return `by ${end}`;
        const sameMeridiem = start.slice(-2) === end.slice(-2);
        return `${sameMeridiem ? start.slice(0, -3) : start}–${end}`;
    },

    formatRelativeDate(dateStr, todayStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const today = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.round((date - today) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Tomorrow';
        if (diffDays === -1) return 'Yesterday';
        if (diffDays < -1) return `${Math.abs(diffDays)} days ago`;

        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        if (diffDays <= 6) return dayNames[date.getDay()];

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthDay = `${monthNames[date.getMonth()]} ${date.getDate()}`;
        return date.getFullYear() === today.getFullYear()
            ? monthDay
            : `${monthDay}, ${date.getFullYear()}`;
    },

    getRepeatLabel(item) {
        switch (item.repeat) {
            case 'daily': return 'Daily';
            case 'weekdays': return 'Weekdays';
            case 'weekly': {
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                return `Every ${days[item.dayOfWeek || 0]}`;
            }
            case 'custom': {
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                return (item.repeatDays || []).map(d => days[d]).join(', ');
            }
            case 'monthly': {
                if (item.scheduledDate) {
                    const day = parseInt(item.scheduledDate.split('-')[2]);
                    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
                    return `Monthly (${day}${suffix})`;
                }
                return 'Monthly';
            }
            case 'annually': {
                if (item.scheduledDate) {
                    const parts = item.scheduledDate.split('-');
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    return `Annually (${monthNames[parseInt(parts[1]) - 1]} ${parseInt(parts[2])})`;
                }
                return 'Annually';
            }
            default: return '';
        }
    },

    getReminderLabel(item) {
        if (!item.reminderDaysBefore?.length) return '';
        const days = item.reminderDaysBefore.filter(d => d > 0).sort((a, b) => b - a);
        if (days.length === 0) return '';
        if (days.length === 1) return `${days[0]}d before`;
        return `${days[0]}d, ${days.slice(1).join('d, ')}d before`;
    },
};
