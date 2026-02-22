import { cn } from '@/utils';
import AnsiToHtml from 'ansi-to-html';
import { useEffect, useState } from 'react';
import { StickToBottomContainer, StickToBottomContent } from '@/components/AutoScroll';

const LogViewer = ({ logs, className }: { logs: string[]; className?: string }) => {
	const [htmlLogs, setHtmlLogs] = useState('');

	useEffect(() => {
		const convert = new AnsiToHtml();
		const html = logs.map((log) => convert.toHtml(log)).join('<br/>');
		setHtmlLogs(html);
	}, [logs]);

	return (
		<StickToBottomContainer
			className={cn('log-viewer bg-gray-900 text-gray-100 overflow-auto text-xs', className)}
		>
			<StickToBottomContent>
				<div dangerouslySetInnerHTML={{ __html: htmlLogs }} className='whitespace-pre' />
			</StickToBottomContent>
		</StickToBottomContainer>
	);
};

export default LogViewer;
