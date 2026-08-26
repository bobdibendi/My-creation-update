import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cx } from './cx'

/**
 * `size` shadows the native numeric `size` attribute, which is meaningless for
 * these fields, so it is omitted from the base props.
 */
interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  icon?: ReactNode
  trailing?: ReactNode
  invalid?: boolean
  size?: 'sm' | 'md' | 'lg'
}

/**
 * Text input wrapped in a focus-ring shell.
 *
 * The ring is drawn on the wrapper rather than the input so leading and
 * trailing slots sit inside the highlighted area.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, trailing, invalid = false, size = 'md', className, ...rest },
  ref,
) {
  return (
    <div className={cx('ui-field', `ui-field--${size}`, invalid && 'is-invalid', className)}>
      {icon && <span className="ui-field__icon">{icon}</span>}
      <input ref={ref} className="ui-field__input" aria-invalid={invalid || undefined} {...rest} />
      {trailing && <span className="ui-field__trailing">{trailing}</span>}
    </div>
  )
})

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cx('ui-textarea', invalid && 'is-invalid', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
})

interface SwitchProps {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, description, disabled = false }: SwitchProps) {
  return (
    <label className={cx('ui-switch', disabled && 'is-disabled')}>
      <span className="ui-switch__text">
        <span className="ui-switch__label">{label}</span>
        {description && <span className="ui-switch__desc">{description}</span>}
      </span>
      <span className="ui-switch__control">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
        />
        <span className="ui-switch__track" aria-hidden>
          <span className="ui-switch__thumb" />
        </span>
      </span>
    </label>
  )
}

interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  label: string
  /** Rendered next to the label; keep it short. */
  valueLabel?: string
}

export function Slider({ value, min, max, step = 1, onChange, label, valueLabel }: SliderProps) {
  return (
    <label className="ui-slider">
      <span className="ui-slider__head">
        <span>{label}</span>
        {valueLabel && <span className="ui-slider__value">{valueLabel}</span>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
    </label>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

interface SegmentedProps<T extends string> {
  value: T
  options: Array<SegmentedOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
}

/** Radio group rendered as a segmented control. */
export function Segmented<T extends string>({
  value, options, onChange, ariaLabel, size = 'md',
}: SegmentedProps<T>) {
  return (
    <div className={cx('ui-segmented', `ui-segmented--${size}`)} role="radiogroup" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={cx('ui-segmented__item', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <span className="ui-segmented__icon">{option.icon}</span>}
          {option.label}
        </button>
      ))}
    </div>
  )
}
