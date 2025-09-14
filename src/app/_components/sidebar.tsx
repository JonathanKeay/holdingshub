'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, Upload, Settings, Pencil, Wallet } from 'lucide-react';
import clsx from 'clsx';

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

    return (
        <aside className="h-screen w-16 bg-themeblue text-white flex flex-col pt-4 px-2 pb-6">
            <div className="space-y-6">
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

            {/* Settings about 4/5 down */}
            <div className="pb-4">
                {bottomNavItems.map((item) => (
                    <LinkItem key={item.label} {...item} />
                ))}
            </div>
        </aside>
    );
}
