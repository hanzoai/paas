import type { ComponentProps } from 'react';
import { StickToBottom } from 'use-stick-to-bottom';
import { cn } from '@/utils';

export type StickToBottomContainerProps = ComponentProps<typeof StickToBottom>;

export const StickToBottomContainer = ({ className, ...props }: StickToBottomContainerProps) => (
	<StickToBottom
		className={cn('relative flex-1 overflow-y-auto', className)}
		initial='smooth'
		resize='smooth'
		role='log'
		{...props}
	/>
);

export type StickToBottomContentProps = ComponentProps<typeof StickToBottom.Content>;

export const StickToBottomContent = ({ className, ...props }: StickToBottomContentProps) => (
	<StickToBottom.Content className={cn('p-4', className)} {...props} />
);
