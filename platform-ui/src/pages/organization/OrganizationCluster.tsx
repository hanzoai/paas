import { Button } from '@/components/Button';
import { Loading } from '@/components/Loading';
import ClusterService from '@/services/ClusterService';
import useOrganizationStore from '@/store/organization/organizationStore';
import { useEffect, useState } from 'react';

type ClusterStatus = {
	status: { state: string; message?: string };
	endpoint: string;
	ha: boolean;
	region: string;
	version: string;
	nodePools: Array<{
		id: string;
		name: string;
		size: string;
		count: number;
		auto_scale: boolean;
		nodes: Array<{ id: string; name: string; status: { state: string } }>;
	}>;
	createdAt: string;
};

export default function OrganizationCluster() {
	const { organization } = useOrganizationStore();
	const [status, setStatus] = useState<ClusterStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [provisioning, setProvisioning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const orgDoks = (organization as any)?.doks;
	const hasCluster = orgDoks?.clusterId && orgDoks?.status !== 'error';

	useEffect(() => {
		if (!organization?._id) return;
		loadStatus();
	}, [organization?._id]);

	async function loadStatus() {
		if (!organization?._id) return;
		setLoading(true);
		setError(null);
		try {
			const data = await ClusterService.getDOKSStatus(organization._id);
			setStatus(data);
		} catch (err: any) {
			if (err?.response?.status !== 404) {
				setError(err?.response?.data?.details || err.message);
			}
		} finally {
			setLoading(false);
		}
	}

	async function handleProvision() {
		if (!organization?._id) return;
		setProvisioning(true);
		setError(null);
		try {
			await ClusterService.provisionDOKS({
				orgId: organization._id,
				region: 'sfo3',
				nodeSize: 's-2vcpu-4gb',
				nodeCount: 2,
			});
			// Poll for status
			setTimeout(loadStatus, 3000);
		} catch (err: any) {
			setError(err?.response?.data?.details || err.message);
		} finally {
			setProvisioning(false);
		}
	}

	async function handleUpgradeHA() {
		if (!organization?._id) return;
		try {
			await ClusterService.upgradeDOKSHA(organization._id);
			loadStatus();
		} catch (err: any) {
			setError(err?.response?.data?.details || err.message);
		}
	}

	async function handleDownloadKubeconfig() {
		if (!organization?._id) return;
		try {
			const kubeconfig = await ClusterService.getDOKSKubeconfig(organization._id);
			const blob = new Blob([kubeconfig], { type: 'text/yaml' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `kubeconfig-${organization.name.toLowerCase().replace(/\s+/g, '-')}.yaml`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err: any) {
			setError(err?.response?.data?.details || err.message);
		}
	}

	if (loading) {
		return (
			<div className='flex items-center justify-center h-64'>
				<Loading />
			</div>
		);
	}

	// No cluster yet - show provisioning UI
	if (!hasCluster && !status) {
		return (
			<div className='space-y-6 p-6'>
				<div>
					<h2 className='text-2xl font-semibold text-default'>Kubernetes Cluster</h2>
					<p className='text-subtle mt-1'>
						Launch a dedicated Kubernetes cluster for this organization. Each org gets
						full isolation with its own nodes, secrets, and workloads.
					</p>
				</div>

				{error && (
					<div className='rounded-lg border border-elements-strong-red bg-elements-subtle-red/10 p-4 text-sm text-elements-strong-red'>
						{error}
					</div>
				)}

				<div className='rounded-lg border border-border bg-base-800 p-6 space-y-4'>
					<h3 className='font-semibold text-default'>Launch Cluster</h3>
					<div className='grid grid-cols-2 gap-4 text-sm'>
						<div>
							<span className='text-subtle'>Region:</span>
							<span className='ml-2 text-default'>San Francisco (sfo3)</span>
						</div>
						<div>
							<span className='text-subtle'>Nodes:</span>
							<span className='ml-2 text-default'>2x s-2vcpu-4gb</span>
						</div>
						<div>
							<span className='text-subtle'>Control Plane:</span>
							<span className='ml-2 text-default'>Free (upgradable to HA for $40/mo)</span>
						</div>
						<div>
							<span className='text-subtle'>Auto-scaling:</span>
							<span className='ml-2 text-default'>1-6 nodes</span>
						</div>
					</div>
					<div className='pt-2'>
						<Button
							variant='primary'
							size='lg'
							onClick={handleProvision}
							disabled={provisioning}
						>
							{provisioning ? 'Provisioning...' : 'Launch Kubernetes Cluster'}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	// Cluster exists - show management UI
	return (
		<div className='space-y-6 p-6'>
			<div className='flex items-center justify-between'>
				<div>
					<h2 className='text-2xl font-semibold text-default'>Kubernetes Cluster</h2>
					<p className='text-subtle mt-1'>
						Manage your organization's dedicated Kubernetes cluster.
					</p>
				</div>
				<div className='flex items-center gap-2'>
					<Button variant='secondary' size='sm' onClick={handleDownloadKubeconfig}>
						Download Kubeconfig
					</Button>
					<Button variant='secondary' size='sm' onClick={loadStatus}>
						Refresh
					</Button>
				</div>
			</div>

			{error && (
				<div className='rounded-lg border border-elements-strong-red bg-elements-subtle-red/10 p-4 text-sm text-elements-strong-red'>
					{error}
				</div>
			)}

			{/* Cluster Info */}
			<div className='rounded-lg border border-border bg-base-800 p-6 space-y-4'>
				<div className='flex items-center justify-between'>
					<h3 className='font-semibold text-default'>Cluster Overview</h3>
					<span
						className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
							status?.status?.state === 'running'
								? 'bg-elements-subtle-green/20 text-elements-strong-green'
								: 'bg-elements-subtle-yellow/20 text-elements-strong-yellow'
						}`}
					>
						{status?.status?.state || orgDoks?.status || 'unknown'}
					</span>
				</div>
				<div className='grid grid-cols-2 gap-4 text-sm'>
					<div>
						<span className='text-subtle'>Region:</span>
						<span className='ml-2 text-default'>{status?.region || orgDoks?.region}</span>
					</div>
					<div>
						<span className='text-subtle'>Version:</span>
						<span className='ml-2 text-default'>{status?.version || 'N/A'}</span>
					</div>
					<div>
						<span className='text-subtle'>Endpoint:</span>
						<span className='ml-2 text-default font-mono text-xs'>
							{status?.endpoint || orgDoks?.endpoint || 'Pending...'}
						</span>
					</div>
					<div className='flex items-center'>
						<span className='text-subtle'>HA Control Plane:</span>
						<span className='ml-2 text-default'>
							{status?.ha || orgDoks?.ha ? 'Enabled' : 'Disabled'}
						</span>
						{!(status?.ha || orgDoks?.ha) && (
							<Button
								variant='secondary'
								size='sm'
								className='ml-2'
								onClick={handleUpgradeHA}
							>
								Upgrade ($40/mo)
							</Button>
						)}
					</div>
				</div>
			</div>

			{/* Node Pools */}
			<div className='rounded-lg border border-border bg-base-800 p-6 space-y-4'>
				<div className='flex items-center justify-between'>
					<h3 className='font-semibold text-default'>Node Pools</h3>
				</div>
				{(status?.nodePools || []).map((pool) => (
					<div
						key={pool.id}
						className='rounded border border-border bg-base-900 p-4 space-y-2'
					>
						<div className='flex items-center justify-between'>
							<span className='font-medium text-default'>{pool.name}</span>
							<span className='text-sm text-subtle'>
								{pool.count} node{pool.count !== 1 ? 's' : ''} &middot; {pool.size}
							</span>
						</div>
						{pool.nodes && (
							<div className='grid grid-cols-3 gap-2'>
								{pool.nodes.map((node) => (
									<div
										key={node.id}
										className='text-xs flex items-center gap-1'
									>
										<span
											className={`inline-block w-2 h-2 rounded-full ${
												node.status.state === 'running'
													? 'bg-elements-strong-green'
													: 'bg-elements-strong-yellow'
											}`}
										/>
										<span className='text-subtle truncate'>{node.name}</span>
									</div>
								))}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
