'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Building2,
  ChevronRight,
  Plus,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@hanzo/ui/primitives'
import { Button, Input } from '@hanzo/ui/primitives'
import { EmptyState } from '@/components/empty-state'
import { trpc } from '@/lib/trpc'

type Org = {
  id: string
  name: string
  pictureUrl: string | null
  role: string
}

function OrgCard({ org }: { org: Org }) {
  return (
    <Link
      href={`/orgs/${org.id}`}
      className="group relative rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-5 transition-all duration-200 hover:border-zinc-700 hover:bg-zinc-900"
    >
      <div className="flex items-start gap-4">
        <Avatar className="h-10 w-10 rounded-lg ring-1 ring-white/10">
          <AvatarImage src={org.pictureUrl ?? undefined} />
          <AvatarFallback className="rounded-lg bg-zinc-800 text-sm font-medium text-zinc-300">
            {org.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 overflow-hidden">
          <h3 className="text-sm font-semibold text-zinc-100 group-hover:text-white transition-colors">
            {org.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {org.role}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-zinc-700 transition-all group-hover:text-zinc-400 group-hover:translate-x-0.5" />
      </div>
    </Link>
  )
}

export default function OrgsPage() {
  const [open, setOpen] = useState(false)
  const [newOrgName, setNewOrgName] = useState('')

  const utils = trpc.useUtils()
  const orgsQuery = trpc.organization.list.useQuery()
  const createOrg = trpc.organization.create.useMutation({
    onSuccess() {
      utils.organization.list.invalidate()
      setOpen(false)
      setNewOrgName('')
    },
  })

  const orgs = orgsQuery.data ?? []
  const isEmpty = orgs.length === 0
  const isLoading = orgsQuery.isLoading

  return (
    <div>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Organizations</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Manage your organizations and their clusters.
          </p>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2 bg-white text-zinc-900 hover:bg-zinc-200">
              <Plus className="h-3.5 w-3.5" />
              New Organization
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-800">
            <DialogHeader>
              <DialogTitle className="text-zinc-100">Create Organization</DialogTitle>
              <DialogDescription className="text-zinc-500">
                Organizations group projects, clusters, and team members.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Name</label>
                <Input
                  placeholder="My Organization"
                  value={newOrgName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrgName(e.target.value)}
                  className="bg-zinc-800/50 border-zinc-700"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} className="border-zinc-700 text-zinc-300">
                Cancel
              </Button>
              <Button
                onClick={() => createOrg.mutate({ name: newOrgName })}
                disabled={createOrg.isPending || newOrgName.length < 2}
                className="bg-white text-zinc-900 hover:bg-zinc-200"
              >
                {createOrg.isPending ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-600" />
        </div>
      ) : isEmpty ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Create an organization to start deploying projects across your clusters."
          action={
            <Button onClick={() => setOpen(true)} className="gap-2 bg-white text-zinc-900 hover:bg-zinc-200">
              <Plus className="h-4 w-4" />
              Create your first organization
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => (
            <OrgCard key={org.id} org={org} />
          ))}
        </div>
      )}

      {orgsQuery.error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load organizations: {orgsQuery.error.message}
        </div>
      )}
    </div>
  )
}
