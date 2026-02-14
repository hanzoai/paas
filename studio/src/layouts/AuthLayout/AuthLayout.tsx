import { Alert, AlertDescription, AlertTitle } from '@/components/Alert';
import { Hanzo } from '@/components/icons';
import Providers from '@/features/auth/Providers/Providers';
import { APIError } from '@/types';
import { cn } from '@/utils';

type AuthLayoutProps = {
	error?: APIError;
	className?: string;
	title: string;
	subtitle: string;
};

export default function AuthLayout({ className, error, title, subtitle }: AuthLayoutProps) {
	return (
		<div
			className={cn(
				'h-screen m-auto bg-black flex flex-col items-center justify-center',
				className,
			)}
		>
			<Hanzo className='size-16 text-white mb-4' />
			<div className='space-y-8 max-w-lg'>
				<div className='space-y-2 text-center'>
					<h1 className='text-3xl font-bold text-white'>{title}</h1>
					<p className='text-neutral-400'>{subtitle}</p>
				</div>
				{error?.error && (
					<Alert className='!max-w-full' variant='error'>
						<AlertTitle>{error.error}</AlertTitle>
						<AlertDescription>{error.details}</AlertDescription>
					</Alert>
				)}
				<Providers />
			</div>
		</div>
	);
}
