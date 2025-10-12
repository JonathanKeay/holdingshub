'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, Upload, Settings, Pencil, Wallet, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { useMemo } from 'react';
import { createBrowserClient } from '@supabase/ssr';

const topNavItems = [
	{ label: 'Dashboard', icon: Home, href: '/' },
	{ label: 'Import', icon: Upload, href: '/import' },
	{ label: 'Edit Assets', icon: Pencil, href: '/assets/edit' },
];

const toolsNavItems = [
	{ label: 'Cash Balance', icon: Wallet, href: '/tools/cash-balance' },
];

const bottomNavItems = [
	{ label: 'Settings', icon: Settings, href: '/settings' },
];

export function Sidebar() {
	const pathname = usePathname();
	const router = useRouter();
	const supabase = useMemo(
		() =>
			createBrowserClient(
				process.env.NEXT_PUBLIC_SUPABASE_URL!,
				process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
			),
		[]
	);

	const LinkItem = ({
		label,
		icon: Icon,
		href,
	}: {
		label: string;
		icon: any;
		href: string;
	}) => (
		<Link
			href={href}
			className={clsx(
				'flex flex-col items-center text-xs hover:text-blue-400 transition',
				pathname === href ? 'text-blue-400' : 'text-gray-300'
			)}
		>
			<Icon className="h-6 w-6 mb-1" />
			<span className="text-xs text-center">{label}</span>
		</Link>
	);

	const onSignOut = async () => {
		try {
			await supabase.auth.signOut();
		} finally {
			router.replace('/login');
			router.refresh();
		}
	};

	return (
			<aside className="h-screen w-16 bg-themeblue text-white flex flex-col pt-4 px-2 pb-6">
				<div className="space-y-6">
					{/* App mark */}
					<div className="flex items-center justify-center mb-2">
						<Link href="/" aria-label="HoldingsHub">
							<img src="/holdingshub-mark.svg" alt="HoldingsHub" width={24} height={24} />
						</Link>
					</div>
				{topNavItems.map((item) => (
					<LinkItem key={item.label} {...item} />
				))}

				{/* Tools section */}
				<div className="h-px bg-gray-700 mx-1 my-2" />
				{toolsNavItems.map((item) => {
					if (item.href === '/tools/cash-balance') {
						return (
							<button
								key={item.label}
								type="button"
								onClick={() => {
									router.push(`/tools/cash-balance?reset=${Date.now()}`);
								}}
								className={clsx(
									'flex flex-col items-center text-xs hover:text-blue-400 transition w-full',
									pathname.startsWith('/tools/cash-balance') ? 'text-blue-400' : 'text-gray-300'
								)}
								style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer' }}
							>
								<item.icon className="h-6 w-6 mb-1" />
								<span className="text-xs text-center">{item.label}</span>
							</button>
						);
					}
					return <LinkItem key={item.label} {...item} />;
				})}
			</div>

			{/* Spacer to push settings down */}
			<div className="flex-grow" />

			{/* Settings + Sign out at bottom */}
			<div className="pb-4">
				{bottomNavItems.map((item) => (
					<LinkItem key={item.label} {...item} />
				))}

				{/* small gap between Settings and Sign out */}
				<div className="h-2" />

				<button
					type="button"
					onClick={onSignOut}
					className={clsx(
						'mt-2 flex flex-col items-center text-xs hover:text-blue-400 transition w-full text-gray-300'
					)}
					title="Sign out"
					aria-label="Sign out"
					style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer' }}
				>
					<LogOut className="h-6 w-6 mb-1" />
					<span className="text-xs text-center">Sign out</span>
				</button>
			</div>
		</aside>
	);
}
