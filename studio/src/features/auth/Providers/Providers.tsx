import { Button } from '@/components/Button';
import { Bitbucket, Github, Gitlab, Hanzo } from '@/components/icons';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// OAuth flows go through hanzo.id as a unified gateway
const IAM_ORIGIN = import.meta.env.VITE_IAM_ORIGIN || 'https://hanzo.id';
const IAM_CLIENT_ID = import.meta.env.VITE_IAM_CLIENT_ID || 'hanzo-app-client-id';
const IAM_SCOPE = import.meta.env.VITE_IAM_SCOPE || 'openid profile email';

// Comma-separated list of enabled providers. Default: hanzo only.
// Set VITE_AUTH_PROVIDERS=hanzo,github,gitlab,bitbucket to enable all.
const ENABLED_PROVIDERS = (import.meta.env.VITE_AUTH_PROVIDERS || 'hanzo')
	.split(',')
	.map((p: string) => p.trim());

type LoginProvider = 'hanzo' | 'github' | 'gitlab' | 'bitbucket';

export default function Providers() {
	const [_, setSearchParams] = useSearchParams();

	const getCallbackUrl = useCallback((provider: LoginProvider) => {
		const oauthPath =
			provider === 'hanzo' ? '/oauth/hanzo/platform' : `/oauth/${provider}/platform`;
		const oauthUrl = new URL(`${IAM_ORIGIN}${oauthPath}`);
		const currentUrl = new URL(window.location.href);
		currentUrl.searchParams.set('provider', provider);
		oauthUrl.searchParams.set('redirect', currentUrl.toString());
		if (provider === 'hanzo') {
			oauthUrl.searchParams.set('client_id', IAM_CLIENT_ID);
			oauthUrl.searchParams.set('scope', IAM_SCOPE);
		}

		return decodeURIComponent(oauthUrl.toString());
	}, []);

	function onProviderClick(provider: LoginProvider) {
		const url = getCallbackUrl(provider);
		if (provider === 'hanzo') {
			localStorage.removeItem('provider');
		} else {
			localStorage.setItem('provider', provider);
		}
		setSearchParams({});
		window.location.href = url;
	}

	return (
		<div className='flex flex-col items-center gap-4 w-full'>
			<Button variant='secondary' size='2xl' onClick={() => onProviderClick('hanzo')}>
				<Hanzo className='mr-2 size-5' />
				Sign in with Hanzo
			</Button>
			{ENABLED_PROVIDERS.includes('github') && (
				<Button variant='secondary' size='2xl' onClick={() => onProviderClick('github')}>
					<Github className='mr-2 size-5' />
					Continue with GitHub
				</Button>
			)}
			{ENABLED_PROVIDERS.includes('gitlab') && (
				<Button variant='secondary' size='2xl' onClick={() => onProviderClick('gitlab')}>
					<Gitlab className='mr-2 size-8' />
					Continue with GitLab
				</Button>
			)}
			{ENABLED_PROVIDERS.includes('bitbucket') && (
				<Button variant='secondary' size='2xl' onClick={() => onProviderClick('bitbucket')}>
					<Bitbucket className='mr-2 size-4' />
					Continue with Bitbucket
				</Button>
			)}
		</div>
	);
}
