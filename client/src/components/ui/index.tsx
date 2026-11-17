import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  AlertTriangle,
  X,
  Inbox,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { useToastStore } from '../../stores/toastStore';

/* ---------------- BUTTON ---------------- */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      leftIcon,
      rightIcon,
      children,
      ...props
    },
    ref
  ) => {
    const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
      primary:
        'bg-[#7C5CFF] hover:bg-[#6D4AFF] text-white shadow-[0_1px_0_rgba(255,255,255,0.16)_inset,0_8px_20px_-6px_rgba(124,92,255,0.5)] border border-[#8E72FF]/40',
      secondary:
        'bg-[#18181F] hover:bg-[#22222C] text-zinc-100 border border-white/10',
      outline:
        'bg-transparent hover:bg-white/[0.04] text-zinc-200 border border-white/15',
      ghost: 'bg-transparent hover:bg-white/[0.05] text-zinc-300 hover:text-white border border-transparent',
      danger:
        'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30',
    };

    const sizes: Record<NonNullable<ButtonProps['size']>, string> = {
      sm: 'h-8 px-3 text-xs rounded-lg gap-1.5',
      md: 'h-10 px-4 text-sm rounded-xl gap-2',
      lg: 'h-12 px-6 text-sm font-semibold rounded-xl gap-2.5',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF]/60 disabled:opacity-50 disabled:cursor-not-allowed select-none',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : leftIcon}
        {children}
        {!loading && rightIcon}
      </button>
    );
  }
);
Button.displayName = 'Button';

/* ---------------- INPUT ---------------- */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightElement?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, leftIcon, rightElement, id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-zinc-300">
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <span className="absolute left-3.5 text-zinc-500 pointer-events-none">{leftIcon}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'w-full h-10 rounded-xl bg-[#111116] border border-white/10 px-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 transition-colors focus:outline-none focus:border-[#7C5CFF] focus:ring-1 focus:ring-[#7C5CFF]/40 disabled:opacity-50',
              leftIcon && 'pl-10',
              rightElement && 'pr-10',
              error && 'border-red-500/60 focus:border-red-500 focus:ring-red-500/30',
              className
            )}
            {...props}
          />
          {rightElement && <div className="absolute right-3">{rightElement}</div>}
        </div>
        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : hint ? (
          <p className="text-xs text-zinc-500">{hint}</p>
        ) : null}
      </div>
    );
  }
);
Input.displayName = 'Input';

/* ---------------- SELECT ---------------- */
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}

export const Select: React.FC<SelectProps> = ({
  className,
  label,
  error,
  options,
  id,
  ...props
}) => {
  const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label htmlFor={selectId} className="block text-xs font-medium text-zinc-300">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={cn(
          'w-full h-10 rounded-xl bg-[#111116] border border-white/10 px-3.5 text-sm text-zinc-100 focus:outline-none focus:border-[#7C5CFF] focus:ring-1 focus:ring-[#7C5CFF]/40',
          className
        )}
        {...props}
      >
        {options.map((o) => (
          <option
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            className="bg-[#15151B] text-zinc-100"
          >
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
};

/* ---------------- TEXTAREA ---------------- */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, id, ...props }, ref) => {
    const areaId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={areaId} className="block text-xs font-medium text-zinc-300">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={areaId}
          className={cn(
            'w-full rounded-xl bg-[#111116] border border-white/10 p-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#7C5CFF] focus:ring-1 focus:ring-[#7C5CFF]/40',
            error && 'border-red-500/60',
            className
          )}
          {...props}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';

/* ---------------- CARD ---------------- */
export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn(
      'rounded-2xl bg-[#131319] border border-white/[0.08] shadow-studio',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

/* ---------------- BADGE ---------------- */
export const Badge: React.FC<{
  variant?: 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
  children: React.ReactNode;
}> = ({ variant = 'default', className, children }) => {
  const styles = {
    default: 'bg-zinc-800/80 text-zinc-300 border-white/10',
    brand: 'bg-[#7C5CFF]/15 text-[#B4A2FF] border-[#7C5CFF]/30',
    success: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
    warning: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
    danger: 'bg-red-500/12 text-red-300 border-red-500/25',
    info: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border',
        styles[variant],
        className
      )}
    >
      {children}
    </span>
  );
};

/* ---------------- SWITCH ---------------- */
export const Switch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  description?: string;
}> = ({ checked, onChange, label, description }) => (
  <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
    {(label || description) && (
      <div>
        {label && <div className="text-sm font-medium text-zinc-200">{label}</div>}
        {description && <div className="text-xs text-zinc-500">{description}</div>}
      </div>
    )}
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors duration-150',
        checked ? 'bg-[#7C5CFF] border-[#8E72FF]' : 'bg-zinc-800 border-white/10'
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-white transition-transform duration-150 mt-0.5',
          checked ? 'translate-x-5' : 'translate-x-1'
        )}
      />
    </button>
  </label>
);

/* ---------------- PROGRESS BAR ---------------- */
export const ProgressBar: React.FC<{
  value: number;
  className?: string;
  barClassName?: string;
}> = ({ value, className, barClassName }) => {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('w-full h-2 rounded-full bg-zinc-800/90 overflow-hidden', className)}>
      <div
        className={cn(
          'h-full rounded-full bg-gradient-to-r from-[#7C5CFF] to-[#38BDF8] transition-all duration-300',
          barClassName
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

/* ---------------- SPINNER & SKELETON ---------------- */
export const Spinner: React.FC<{ size?: 'sm' | 'md' | 'lg'; className?: string }> = ({
  size = 'md',
  className,
}) => {
  const sizes = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-9 h-9' };
  return <Loader2 className={cn('animate-spin text-[#7C5CFF]', sizes[size], className)} />;
};

export const Skeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn('animate-pulse rounded-xl bg-white/[0.05]', className)} />
);

/* ---------------- MODAL ---------------- */
export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'md' | 'lg' | 'xl';
  children: React.ReactNode;
}> = ({ open, onClose, title, description, size = 'md', children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const maxW = {
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.16 }}
            className={cn(
              'relative z-10 w-full rounded-2xl bg-[#14141B] border border-white/10 shadow-2xl max-h-[90vh] flex flex-col',
              maxW[size]
            )}
          >
            <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/[0.08]">
              <div>
                <h3 className="text-base font-semibold text-white">{title}</h3>
                {description && <p className="text-xs text-zinc-400 mt-0.5">{description}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

/* ---------------- DROPDOWN ---------------- */
export const Dropdown: React.FC<{
  trigger: React.ReactNode;
  align?: 'left' | 'right';
  children: (close: () => void) => React.ReactNode;
}> = ({ trigger, align = 'right', children }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((o) => !o)} className="cursor-pointer">
        {trigger}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={cn(
              'absolute mt-2 z-50 min-w-[220px] rounded-xl bg-[#16161E] border border-white/10 shadow-2xl py-1.5',
              align === 'right' ? 'right-0' : 'left-0'
            )}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* ---------------- EMPTY & ERROR STATES ---------------- */
export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}> = ({ icon, title, description, action }) => (
  <div className="flex flex-col items-center justify-center text-center py-14 px-6 rounded-2xl border border-dashed border-white/10 bg-[#111116]/60">
    <div className="w-12 h-12 rounded-2xl bg-[#7C5CFF]/12 border border-[#7C5CFF]/25 flex items-center justify-center text-[#9E85FF] mb-4">
      {icon || <Inbox className="w-5 h-5" />}
    </div>
    <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
    <p className="text-sm text-zinc-400 max-w-md mt-1.5 mb-5">{description}</p>
    {action}
  </div>
);

export const ErrorState: React.FC<{
  title?: string;
  message: string;
  onRetry?: () => void;
}> = ({ title = 'Unable to load data', message, onRetry }) => (
  <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.06] p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
    <div className="flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
      <div>
        <h4 className="text-sm font-semibold text-red-200">{title}</h4>
        <p className="text-xs text-red-300/80 mt-0.5">{message}</p>
      </div>
    </div>
    {onRetry && (
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    )}
  </div>
);

/* ---------------- TOAST VIEWPORT ---------------- */
export const ToastViewport: React.FC = () => {
  const { toasts, dismiss } = useToastStore();

  const iconFor = (type: string) => {
    switch (type) {
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
      default:
        return <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />;
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2.5 w-full max-w-sm pointer-events-none px-4 sm:px-0">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            className="pointer-events-auto rounded-xl bg-[#181820] border border-white/12 p-3.5 shadow-2xl flex items-start gap-3"
          >
            {iconFor(t.type)}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-100">{t.title}</div>
              {t.description && (
                <div className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{t.description}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="text-zinc-500 hover:text-zinc-200 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
