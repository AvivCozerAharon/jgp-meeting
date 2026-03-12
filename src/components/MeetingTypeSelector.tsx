// components/MeetingTypeSelector.tsx — Feature 8
import type { MeetingType } from '../types';
import { MEETING_TYPE_LABELS, MEETING_TYPE_ICONS } from '../types';

const ALL_TYPES: MeetingType[] = [
  'general',
  'standup',
  'one_on_one',
  'retrospective',
  'commercial',
  'interview',
];

interface Props {
  value: MeetingType;
  onChange: (type: MeetingType) => void;
  disabled?: boolean;
}

export function MeetingTypeSelector({ value, onChange, disabled }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">
        Tipo de Reunião
      </span>
      <div className="flex flex-wrap gap-1.5">
        {ALL_TYPES.map((type) => {
          const isActive = value === type;
          return (
            <button
              key={type}
              onClick={() => !disabled && onChange(type)}
              disabled={disabled}
              className={[
                'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium',
                'border transition-all duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                isActive
                  ? 'bg-primary-500 border-primary-500 text-white shadow-sm'
                  : 'bg-surface-50 border-surface-200 text-surface-500 hover:border-primary-500 hover:text-primary-500 dark:bg-surface-800 dark:border-surface-600 dark:text-surface-400 dark:hover:border-primary-500 dark:hover:text-primary-400',
              ].join(' ')}
              title={MEETING_TYPE_LABELS[type]}
            >
              <span>{MEETING_TYPE_ICONS[type]}</span>
              <span>{MEETING_TYPE_LABELS[type]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
