'use client';

import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {}

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 data-[state=checked]:bg-blue-600',
      className
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 translate-x-0" />
  </SwitchPrimitives.Root>
));

Switch.displayName = 'Switch';
