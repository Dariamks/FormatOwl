'use client';

import { useRef, useState, type ComponentProps } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useLocale } from 'next-intl';
import { validLocale, localeRegistry } from '@/i18n/registry';
import { cn } from '@/lib/utils';

export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
  const locale = validLocale(useLocale());
  return <SelectPrimitive.Root dir={localeRegistry[locale].dir} {...props} />;
}
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger className={cn('select-trigger', className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="select-chevron" size={18} aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  container,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content> &
  Pick<ComponentProps<typeof SelectPrimitive.Portal>, 'container'>) {
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        collisionPadding={12}
        className={cn('select-content', className)}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="select-scroll-button">
          <ChevronUp size={16} aria-hidden="true" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="select-scroll-button">
          <ChevronDown size={16} aria-hidden="true" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** A labelled form field using the same menu as the platform's other selects. */
export function SelectField({
  value,
  onValueChange,
  disabled,
  name,
  placeholder,
  children,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, 'value' | 'onChange'> &
  Pick<ComponentProps<typeof Select>, 'value' | 'onValueChange' | 'name'> & {
    placeholder?: string;
  }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement>();
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
      onOpenChange={(open) => {
        // A modal dialog makes body portals inert. Keep its menu in the same top layer.
        if (open) setContainer(trigger.current?.closest('dialog') ?? undefined);
      }}
    >
      <SelectTrigger {...props} ref={trigger}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent container={container}>{children}</SelectContent>
    </Select>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn('select-item', className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="select-check">
        <Check size={17} strokeWidth={2} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
