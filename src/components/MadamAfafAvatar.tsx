import React from 'react';

interface MadamAfafAvatarProps {
  size?: number;
  className?: string;
  title?: string;
  bordered?: boolean;
}

/**
 * MadamAfafAvatar:
 * High-craft SVG cartoon illustration of Madam Afaf:
 * An elderly, respectable Egyptian woman wearing an elegant veil (hijab),
 * reading glasses perched on her nose with a warm, meticulous gaze,
 * holding up a magnifying glass / inspection microscope to examine code.
 */
export const MadamAfafAvatar: React.FC<MadamAfafAvatarProps> = ({
  size = 40,
  className = '',
  title = 'مدام عفاف',
  bordered = false
}) => {
  return (
    <div
      className={`inline-flex items-center justify-center shrink-0 select-none overflow-hidden rounded-full ${
        bordered ? 'ring-2 ring-[var(--primary)]' : ''
      } ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        backgroundColor: '#0B5D5E',
        boxShadow: 'var(--sh-1)'
      }}
      title={title}
      aria-label={title}
      role="img"
    >
      <svg
        viewBox="0 0 120 120"
        width="100%"
        height="100%"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="afafBgGlow" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#177A7B" />
            <stop offset="100%" stopColor="#083E3F" />
          </radialGradient>
          <linearGradient id="hijabGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1B7879" />
            <stop offset="60%" stopColor="#0B5D5E" />
            <stop offset="100%" stopColor="#063839" />
          </linearGradient>
          <linearGradient id="innerVeilGrad" x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" stopColor="#FAF5EC" />
            <stop offset="100%" stopColor="#E2D4BF" />
          </linearGradient>
          <linearGradient id="skinGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#F9D4B5" />
            <stop offset="100%" stopColor="#E7B38D" />
          </linearGradient>
          <linearGradient id="lensGlint" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.8" />
            <stop offset="45%" stopColor="#9DE4E5" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#3FA3A5" stopOpacity="0.15" />
          </linearGradient>
          <linearGradient id="goldFrame" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FFE082" />
            <stop offset="50%" stopColor="#D4A017" />
            <stop offset="100%" stopColor="#8C6808" />
          </linearGradient>
          <linearGradient id="penGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#B3251B" />
            <stop offset="100%" stopColor="#75150E" />
          </linearGradient>
        </defs>

        {/* Backdrop Circular Portrait */}
        <circle cx="60" cy="60" r="58" fill="url(#afafBgGlow)" />
        <circle cx="60" cy="60" r="57" stroke="#8C7F6F" strokeWidth="1" strokeOpacity="0.3" />

        {/* Soft Background Warm Light Halo */}
        <circle cx="60" cy="50" r="38" fill="#FAF5EC" fillOpacity="0.08" />

        {/* Hijab Back Drapes / Shoulder Cover */}
        <path
          d="M20 114 C20 86 35 74 60 74 C85 74 100 86 100 114 Z"
          fill="url(#hijabGrad)"
        />

        {/* Outer Hijab Head Dome */}
        <path
          d="M60 12 C34 12 24 32 24 58 C24 82 32 94 60 94 C88 94 96 82 96 58 C96 32 86 12 60 12 Z"
          fill="url(#hijabGrad)"
        />

        {/* Inner Underscarf Band (Bandana / Bandoe) */}
        <path
          d="M36 42 C44 33 76 33 84 42 C78 40 42 40 36 42 Z"
          fill="url(#innerVeilGrad)"
        />

        {/* Madam Afaf Face Oval */}
        <path
          d="M60 30 C44 30 38 42 38 60 C38 76 48 84 60 84 C72 84 82 76 82 60 C82 42 76 30 60 30 Z"
          fill="url(#skinGrad)"
        />

        {/* Hijab Inner Face Drape Shadow & Fold */}
        <path
          d="M34 52 C32 74 44 86 60 88 C76 86 88 74 86 52 C82 42 80 34 60 34 C40 34 38 42 34 52 Z"
          fill="none"
          stroke="#073E40"
          strokeWidth="3.5"
          strokeLinecap="round"
        />

        {/* Subtle Elderly Smile Lines / Dignified Brow */}
        <path d="M44 47 C48 45 54 46 56 48" stroke="#8C5C38" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M76 47 C72 45 66 46 64 48" stroke="#8C5C38" strokeWidth="1.8" strokeLinecap="round" />

        {/* Forehead Wisdom Lines (Subtle) */}
        <path d="M52 38 C56 37 64 37 68 38" stroke="#D19C74" strokeWidth="1.2" strokeLinecap="round" />

        {/* Alert, Meticulous Eyes Looking Down/Forward at Evidence */}
        <ellipse cx="50" cy="53" rx="3.5" ry="3" fill="#231C16" />
        <circle cx="51" cy="52" r="1" fill="#FFFFFF" />
        <path d="M45 57 C48 59 52 59 55 57" stroke="#A86D44" strokeWidth="1" fill="none" />

        <ellipse cx="70" cy="53" rx="3.5" ry="3" fill="#231C16" />
        <circle cx="71" cy="52" r="1" fill="#FFFFFF" />
        <path d="M65 57 C68 59 72 59 75 57" stroke="#A86D44" strokeWidth="1" fill="none" />

        {/* Cheerful Rosy Cheeks */}
        <circle cx="43" cy="62" r="4.5" fill="#E67E62" fillOpacity="0.4" />
        <circle cx="77" cy="62" r="4.5" fill="#E67E62" fillOpacity="0.4" />

        {/* Gentle Nose & Reading Glasses Resting on Nose Bridge */}
        <path d="M60 52 C60 59 58 64 62 65" stroke="#BF7F54" strokeWidth="2" strokeLinecap="round" fill="none" />

        {/* Respectful Madam Smile */}
        <path d="M53 71 C57 74 63 74 67 71" stroke="#8E1B12" strokeWidth="2" strokeLinecap="round" fill="none" />

        {/* Reading Glasses Frames (Tortoiseshell/Gold Wire) */}
        <rect
          x="42"
          y="47"
          width="16"
          height="13"
          rx="5"
          fill="#FFFFFF"
          fillOpacity="0.25"
          stroke="url(#goldFrame)"
          strokeWidth="2.2"
        />
        <rect
          x="62"
          y="47"
          width="16"
          height="13"
          rx="5"
          fill="#FFFFFF"
          fillOpacity="0.25"
          stroke="url(#goldFrame)"
          strokeWidth="2.2"
        />
        {/* Glasses Bridge and Temples */}
        <path d="M58 52 C59 50 61 50 62 52" stroke="url(#goldFrame)" strokeWidth="2.2" fill="none" />
        <path d="M42 52 L36 49" stroke="url(#goldFrame)" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M78 52 L84 49" stroke="url(#goldFrame)" strokeWidth="1.8" strokeLinecap="round" />

        {/* Hijab Shoulder Drapes & Fold Detail */}
        <path
          d="M34 85 C38 98 48 108 60 110 C72 108 82 98 86 85"
          fill="none"
          stroke="#073E40"
          strokeWidth="2"
        />

        {/* Red Correction Pen Tucked at Lapel (Madam Afaf Signature) */}
        <g transform="translate(32, 86) rotate(-25)">
          <rect x="0" y="0" width="5" height="18" rx="2" fill="url(#penGrad)" />
          <polygon points="0,0 5,0 2.5,-4" fill="#E0B657" />
          <rect x="1" y="4" width="3" height="2" fill="#FFE082" />
        </g>

        {/* Madam Afaf's Hand Holding Inspection Magnifying Glass / Lens */}
        {/* Hand Silhouette */}
        <ellipse cx="88" cy="88" rx="8" ry="7" fill="#F4C7A3" />
        <ellipse cx="84" cy="84" rx="4" ry="3.5" fill="#F4C7A3" />
        <ellipse cx="89" cy="83" rx="3.5" ry="3" fill="#F4C7A3" />

        {/* Magnifying Glass Handle (Dark Wood/Brass) */}
        <path
          d="M93 93 L106 106"
          stroke="#3A281A"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path
          d="M93 93 L106 106"
          stroke="#D4A017"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* Magnifying Glass Rim (Brass Gold) */}
        <circle
          cx="82"
          cy="80"
          r="16"
          fill="none"
          stroke="url(#goldFrame)"
          strokeWidth="3.5"
        />

        {/* Magnifying Glass Convex Lens with Glint (Inspecting code/evidence) */}
        <circle
          cx="82"
          cy="80"
          r="13.5"
          fill="url(#lensGlint)"
        />
        {/* Micro Inspection Grid / Code Line inside Lens */}
        <path
          d="M75 78 L89 78 M76 82 L86 82"
          stroke="#0B5D5E"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeOpacity="0.75"
        />
        {/* Shiny Lens Highlight Crescent */}
        <path
          d="M73 75 C75 70 82 69 88 72"
          stroke="#FFFFFF"
          strokeWidth="2"
          strokeLinecap="round"
          strokeOpacity="0.85"
          fill="none"
        />
      </svg>
    </div>
  );
};
