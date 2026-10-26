import React from 'react';

interface OfficialStampProps {
  status?: 'approved' | 'conditional' | 'needs_fix' | 'ready';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Authentic Egyptian Bureaucratic Ink Stamp ("ختم شباك 6 المعتمد — مدام عفاف")
 * Strictly contained inside a double circular official seal with zero text overflow.
 */
export const OfficialStamp: React.FC<OfficialStampProps> = ({
  status = 'ready',
  size = 'md',
  className = ''
}) => {
  const config = {
    approved: {
      topText: 'مكتب مدام عفاف',
      centerTitle: 'معتمد ✓',
      centerSub: 'ختم شباك 6',
      bottomText: 'الدور التاني',
      borderColor: 'border-[#14a800]',
      textColor: 'text-[#14a800]',
      bgColor: 'bg-emerald-50/95'
    },
    conditional: {
      topText: 'مكتب مدام عفاف',
      centerTitle: 'يمشي الحال',
      centerSub: 'نفّذ البرومبت',
      bottomText: 'شباك 6 • الدور 2',
      borderColor: 'border-amber-700',
      textColor: 'text-amber-800',
      bgColor: 'bg-amber-50/95'
    },
    needs_fix: {
      topText: 'قرار شباك 6',
      centerTitle: 'يتصلح فوراً',
      centerSub: 'انسخ البرومبت',
      bottomText: 'ختم مدام عفاف',
      borderColor: 'border-rose-700',
      textColor: 'text-rose-800',
      bgColor: 'bg-rose-50/95'
    },
    ready: {
      topText: 'مكتب مدام عفاف',
      centerTitle: 'ختم شباك 6',
      centerSub: 'معتمد رسمياً',
      bottomText: 'الدور التاني',
      borderColor: 'border-amber-400',
      textColor: 'text-amber-300',
      bgColor: 'bg-[#001e00]/95'
    }
  }[status];

  if (size === 'xs') {
    return (
      <span
        className={`inline-flex items-center justify-center w-7 h-7 rounded-full border-2 border-dashed ${config.borderColor} ${config.bgColor} ${config.textColor} font-black text-xs -rotate-12 shadow-xs select-none leading-none ${className}`}
        title="ختم مدام عفاف - شباك 6"
      >
        ختم 6
      </span>
    );
  }

  const dimensions = {
    sm: 'w-24 h-24',
    md: 'w-28 h-28',
    lg: 'w-32 h-32'
  }[size];

  return (
    <div
      className={`relative inline-flex items-center justify-center rounded-full border-2 ${config.borderColor} ${config.bgColor} ${config.textColor} ${dimensions} p-1.5 -rotate-6 select-none shadow-sm overflow-hidden shrink-0 ${className}`}
      role="img"
      aria-label={`ختم مدام عفاف: ${config.centerTitle}`}
    >
      {/* Inner Dashed Ink Stamp Ring */}
      <div
        className={`w-full h-full rounded-full border border-dashed ${config.borderColor} flex flex-col items-center justify-center px-1.5 text-center overflow-hidden`}
      >
        {/* Top Ink Label */}
        <span className="font-extrabold leading-tight text-xs opacity-90 whitespace-nowrap">
          {config.topText}
        </span>

        {/* Center Stamp Verdict */}
        <div className="my-1 py-0.5 border-y border-current/30 w-[90%] flex flex-col items-center justify-center">
          <span className="font-black text-xs leading-tight whitespace-nowrap">
            {config.centerTitle}
          </span>
          <span className="font-bold text-xs leading-tight opacity-90 whitespace-nowrap">
            {config.centerSub}
          </span>
        </div>

        {/* Bottom Ink Label */}
        <span className="font-extrabold leading-tight text-xs opacity-85 whitespace-nowrap">
          ★ {config.bottomText} ★
        </span>
      </div>
    </div>
  );
};
