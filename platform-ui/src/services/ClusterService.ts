import { axios } from "@/helpers";
import {
  Cluster,
  ClusterComponent,
  ClusterReleaseInfo,
  DomainParams,
  EnforceSSLAccessParams,
  TransferRequest,
  UpdateRemainingClusterComponentsParams,
} from "@/types";

export default class ClusterService {
  static url = "/v1/cluster";

  static async checkCompleted(): Promise<{ status: boolean }> {
    return (await axios.get(`${this.url}/setup-status`)).data;
  }

  static async getClusterStorageInfo() {
    return (await axios.get(`/v1/cluster/storage-info`)).data;
  }

  static async transferClusterOwnership({ userId }: TransferRequest) {
    return (
      await axios.post(`/v1/user/transfer/${userId}`, {
        userId,
      })
    ).data;
  }

  static async getClusterInfo() {
    return (await axios.get(`${this.url}/info`)).data;
  }

  static async getClusterAndReleaseInfo(): Promise<ClusterReleaseInfo> {
    return (await axios.get(`${this.url}/release-info`)).data;
  }
  static async updateClusterRelease(data: { release: string }) {
    return (await axios.put(`${this.url}/update-release`, data)).data;
  }
  static async addDomain(data: DomainParams): Promise<Cluster> {
    return (await axios.post(`${this.url}/domains`, data)).data;
  }
  static async deleteDomain(data: DomainParams): Promise<Cluster> {
    return (await axios.delete(`${this.url}/domains`, { data })).data;
  }
  static async enforceSSL(data: EnforceSSLAccessParams): Promise<Cluster> {
    return (await axios.put(`${this.url}/domains/enforce-ssl`, data)).data;
  }
  static async checkDomainStatus() {
    return (await axios.get(`${this.url}/domain-status`)).data;
  }
  static async updateRemainingClusterComponents(
    data: UpdateRemainingClusterComponentsParams
  ): Promise<ClusterComponent> {
    return (await axios.put(`${this.url}/${data.componentName}/update`, data))
      .data;
  }

  static async enabledCICD() {
    return (await axios.post(`${this.url}/cicd/enable`, {})).data;
  }
  static async disabledCICD() {
    return (await axios.post(`${this.url}/cicd/disable`, {})).data;
  }

  static async getContainerTemplates() {
    return (await axios.get(`${this.url}/templates`)).data;
  }
  static async getContainerTemplate(name: string, version: string) {
    return (
      await axios.get(`${this.url}/template`, { params: { name, version } })
    ).data;
  }

  static async setReverseProxyURL(reverseProxyURL: string): Promise<Cluster> {
    return (
      await axios.put(`${this.url}/reverse-proxy-url`, {
        reverseProxyURL: reverseProxyURL || undefined,
      })
    ).data;
  }

  static async getAllRegistries() {
    return (await axios.get("/v1/registry")).data;
  }

  static async healthCheck() {
    return (await axios.get(`/health`)).data;
  }

  // --- DOKS Provisioner API ---

  static doksUrl = "/v1/cluster/doks";

  static async getDOKSFleet() {
    return (await axios.get(`${this.doksUrl}/fleet`)).data;
  }

  static async getDOKSOptions() {
    return (await axios.get(`${this.doksUrl}/options`)).data;
  }

  static async getDOKSPricing(sizeSlug: string) {
    return (await axios.get(`${this.doksUrl}/pricing/${sizeSlug}`)).data;
  }

  static async provisionDOKS(params: {
    orgId: string;
    region?: string;
    nodeSize?: string;
    nodeCount?: number;
    ha?: boolean;
  }) {
    return (await axios.post(`${this.doksUrl}/provision`, params)).data;
  }

  static async getDOKSStatus(orgId: string) {
    return (await axios.get(`${this.doksUrl}/${orgId}/status`)).data;
  }

  static async getDOKSKubeconfig(orgId: string): Promise<string> {
    return (await axios.get(`${this.doksUrl}/${orgId}/kubeconfig`)).data;
  }

  static async addDOKSNodePool(
    orgId: string,
    params: { name: string; size: string; count: number }
  ) {
    return (await axios.post(`${this.doksUrl}/${orgId}/node-pools`, params))
      .data;
  }

  static async scaleDOKSNodePool(
    orgId: string,
    poolId: string,
    params: { count?: number; size?: string }
  ) {
    return (
      await axios.put(
        `${this.doksUrl}/${orgId}/node-pools/${poolId}`,
        params
      )
    ).data;
  }

  static async deleteDOKSNodePool(orgId: string, poolId: string) {
    return (
      await axios.delete(`${this.doksUrl}/${orgId}/node-pools/${poolId}`)
    ).data;
  }

  static async upgradeDOKSHA(orgId: string) {
    return (await axios.post(`${this.doksUrl}/${orgId}/upgrade-ha`)).data;
  }

  static async deleteDOKSCluster(orgId: string) {
    return (await axios.delete(`${this.doksUrl}/${orgId}?confirm=true`)).data;
  }

  // --- Billing API ---

  static billingUrl = "/v1/billing";

  static async getFleetBilling() {
    return (await axios.get(`${this.billingUrl}/fleet`)).data;
  }

  static async getOrgBilling(orgId: string) {
    return (await axios.get(`${this.billingUrl}/${orgId}`)).data;
  }
}
