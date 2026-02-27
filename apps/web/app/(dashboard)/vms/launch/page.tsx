'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Loader2,
  Monitor,
  Server,
  Star,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@hanzo/ui/primitives'
import { trpc } from '@/lib/trpc'
import Link from 'next/link'

const PRICING_API = process.env.NEXT_PUBLIC_PRICING_API_URL || '/api'

interface CloudPlan {
  id: string
  name: string
  description: string
  vcpus: number
  memoryGB: number
  diskGB: number
  cpuType: string
  maxVMs: number
  priceMonthly: number
  priceHourly: number
  freeTier?: boolean
  popular?: boolean
  features: string[]
}

interface Region {
  id: string
  name: string
  location: string
  available: boolean
}

const steps = ['Plan', 'Region', 'Review']

export default function LaunchVMPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [plans, setPlans] = useState<CloudPlan[]>([])
  const [regions, setRegions] = useState<Region[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPlan, setSelectedPlan] = useState<string>('')
  const [region, setRegion] = useState('')
  const [name, setName] = useState('')

  // Fetch plans and regions from pricing API
  useEffect(() => {
    Promise.all([
      fetch(`${PRICING_API}/v1/pricing/cloud/plans`).then((r) => r.json()),
      fetch(`${PRICING_API}/v1/pricing/cloud/regions`).then((r) => r.json()),
    ])
      .then(([planData, regionData]) => {
        setPlans(planData?.plans ?? planData ?? [])
        setRegions(regionData?.regions ?? regionData ?? [])
      })
      .catch(() => {
        // Minimal fallback for regions only — plans must come from API
        setRegions([
          { id: 'us-east', name: 'US East', location: 'Ashburn, VA', available: true },
          { id: 'us-west', name: 'US West', location: 'Hillsboro, OR', available: true },
          { id: 'eu-central', name: 'Europe', location: 'Frankfurt, DE', available: true },
          { id: 'ap-southeast', name: 'Asia Pacific', location: 'Singapore', available: true },
        ])
      })
      .finally(() => setLoading(false))
  }, [])

  const plan = plans.find((p) => p.id === selectedPlan)

  const launchMutation = trpc.vm.launch.useMutation({
    onSuccess: (data: any) => {
      router.push(`/vms/${data.id}`)
    },
  })

  const handleLaunch = () => {
    if (!selectedPlan || !region || !name) return
    launchMutation.mutate({
      provider: 'digitalocean' as const,
      size: selectedPlan,
      region,
      name,
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div>
      {/* Page header */}
      <div className="mb-8">
        <Link
          href="/vms"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to VMs
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Launch Virtual Machine</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose a plan, select a region, and launch.
        </p>
      </div>

      {/* Steps indicator */}
      <div className="mb-8 flex items-center gap-2">
        {steps.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-8 bg-border" />}
            <div
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1 text-sm transition-colors',
                i === step
                  ? 'bg-primary text-primary-foreground font-medium'
                  : i < step
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : <span>{i + 1}</span>}
              <span className="hidden sm:inline">{label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Step 0: Choose Plan */}
      {step === 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Choose a Plan</h2>
          {plans.length === 0 ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              Unable to load plans. Please try again later.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {plans.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPlan(p.id)}
                  className={cn(
                    'flex flex-col items-start gap-2 rounded-xl border p-5 text-left transition-all relative',
                    selectedPlan === p.id
                      ? 'border-primary bg-accent ring-1 ring-primary'
                      : 'border-border hover:border-accent-foreground/20 hover:bg-accent/30',
                  )}
                >
                  {p.popular && (
                    <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-primary text-primary-foreground text-xs font-medium rounded-full flex items-center gap-1">
                      <Star className="h-3 w-3" /> Popular
                    </div>
                  )}
                  <Server className="h-5 w-5" />
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-lg font-bold ml-2">${p.priceMonthly}/mo</span>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <div>{p.vcpus} vCPU ({p.cpuType}) &middot; {p.memoryGB} GB RAM</div>
                    <div>{p.diskGB} GB SSD &middot; Up to {p.maxVMs} VM{p.maxVMs > 1 ? 's' : ''}</div>
                  </div>
                  {p.freeTier && (
                    <div className="text-xs text-green-500 font-medium">$5 free credit</div>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-4">
            <Button
              onClick={() => setStep(1)}
              disabled={!selectedPlan}
              className="gap-2"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 1: Region & Name */}
      {step === 1 && (
        <div className="space-y-6 max-w-2xl">
          <h2 className="text-lg font-semibold">Configure Instance</h2>

          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input
              placeholder="my-server"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Region</label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger>
                <SelectValue placeholder="Select region..." />
              </SelectTrigger>
              <SelectContent>
                {regions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} — {r.location}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Same pricing in all regions.</p>
          </div>

          <div className="flex justify-between pt-4">
            <Button variant="outline" onClick={() => setStep(0)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={() => setStep(2)}
              disabled={!name || !region}
              className="gap-2"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Review */}
      {step === 2 && (
        <div className="space-y-6 max-w-2xl">
          <h2 className="text-lg font-semibold">Review & Launch</h2>

          <div className="rounded-xl border p-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Plan</span>
              <span className="font-medium">{plan?.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Name</span>
              <span className="font-medium">{name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Region</span>
              <span className="font-medium">{regions.find((r) => r.id === region)?.name ?? region}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Specs</span>
              <span className="font-medium text-right">
                {plan?.vcpus} vCPU &middot; {plan?.memoryGB} GB &middot; {plan?.diskGB} GB SSD
              </span>
            </div>
            <div className="border-t pt-3 flex items-center justify-between">
              <span className="text-sm font-medium">Monthly Price</span>
              <span className="text-lg font-bold">${plan?.priceMonthly}/mo</span>
            </div>
          </div>

          {launchMutation.error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              {launchMutation.error.message}
            </div>
          )}

          <div className="flex justify-between pt-4">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={handleLaunch}
              disabled={launchMutation.isPending}
              className="gap-2"
            >
              {launchMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Launching...
                </>
              ) : (
                <>
                  <Monitor className="h-4 w-4" />
                  Launch VM
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
