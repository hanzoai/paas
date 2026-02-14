import useAuthStore from "@/store/auth/authStore";
import useClusterStore from "@/store/cluster/clusterStore";
import useContainerStore from "@/store/container/containerStore";
import { resetAllStores } from "@/utils";
import { LoaderFunctionArgs, redirect } from "react-router-dom";

type AuthProvider = "hanzo" | "github" | "gitlab" | "bitbucket";
type GitProvider = "github" | "gitlab" | "bitbucket";

function isGitProvider(provider: string | null): provider is GitProvider {
  return (
    provider === "github" || provider === "gitlab" || provider === "bitbucket"
  );
}

function getAuthProvider(provider: string | null): AuthProvider {
  if (provider === "hanzo" || isGitProvider(provider)) {
    return provider;
  }

  return "hanzo";
}

async function registerLoader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  const accessToken = requestUrl.searchParams.get("access_token");
  const status = requestUrl.searchParams.get("status");
  const error = requestUrl.searchParams.get("error");
  const provider = requestUrl.searchParams.get("provider");

  if (status === "200" && accessToken && !error && isGitProvider(provider)) {
    try {
      await useClusterStore.getState().initializeClusterSetup({
        accessToken,
        provider,
        expiresAt: requestUrl.searchParams.get("expires_at") as string,
        refreshToken: requestUrl.searchParams.get("refresh_token") as string,
      });
      return redirect("/register/setup");
    } catch (error) {
      return error;
    }
  }
  return status;
}

async function loginLoader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  const accessToken = requestUrl.searchParams.get("access_token");
  const status = requestUrl.searchParams.get("status");
  const error = requestUrl.searchParams.get("error");
  const provider = getAuthProvider(requestUrl.searchParams.get("provider"));

  resetAllStores();
  if (status === "200" && accessToken && !error) {
    try {
      await useAuthStore.getState().login({
        accessToken,
        provider,
        expiresAt: requestUrl.searchParams.get("expires_at") as string,
        refreshToken: requestUrl.searchParams.get("refresh_token") as string,
      });

      if (isGitProvider(provider)) {
        await useContainerStore.getState().addGitProvider({
          accessToken,
          provider,
          expiresAt: requestUrl.searchParams.get("expires_at") as string,
          refreshToken: requestUrl.searchParams.get("refresh_token") as string,
        });
      }

      return redirect("/organization");
    } catch (error) {
      return error;
    }
  }
  return status;
}
async function orgAcceptInvitation({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  const accessToken = requestUrl.searchParams.get("access_token");
  const status = requestUrl.searchParams.get("status");
  const error = requestUrl.searchParams.get("error");
  const token = requestUrl.searchParams.get("token");
  const isAuthenticated = useAuthStore.getState().isAuthenticated();
  const provider = localStorage.getItem("provider");

  if (isAuthenticated) {
    useAuthStore.getState().orgAcceptInviteWithSession(token as string);
    return redirect("/organization");
  }

  if (status === "200" && accessToken && !error && isGitProvider(provider)) {
    try {
      await useAuthStore.getState().orgAcceptInvite({
        token: token as string,
        accessToken,
        provider,
        expiresAt: requestUrl.searchParams.get("expires_at") as string,
        refreshToken: requestUrl.searchParams.get("refresh_token") as string,
      });
      localStorage.removeItem("provider");
      return redirect("/organization");
    } catch (error) {
      return error;
    }
  }
  return token;
}
async function projectAcceptInvite({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  const accessToken = requestUrl.searchParams.get("access_token");
  const status = requestUrl.searchParams.get("status");
  const error = requestUrl.searchParams.get("error");
  const token = requestUrl.searchParams.get("token");
  const isAuthenticated = useAuthStore.getState().isAuthenticated();
  const provider = localStorage.getItem("provider");

  if (isAuthenticated) {
    useAuthStore.getState().projectAcceptInviteWithSession(token as string);
    return redirect("/organization");
  }

  if (status === "200" && accessToken && !error && isGitProvider(provider)) {
    try {
      await useAuthStore.getState().projectAcceptInvite({
        token: token as string,
        accessToken,
        provider,
        expiresAt: requestUrl.searchParams.get("expires_at") as string,
        refreshToken: requestUrl.searchParams.get("refresh_token") as string,
      });
      localStorage.removeItem("provider");
      return redirect("/organization");
    } catch (error) {
      return error;
    }
  }
  return token;
}

export default {
  registerLoader,
  loginLoader,
  orgAcceptInvitation,
  projectAcceptInvite,
};
