# Hanzo PaaS

Hanzo PaaS is an open source platform-as-a-service running on Kubernetes clusters. It provides a **complete CD solution for building, deploying, and managing applications in a Kubernetes cluster**. In short, you connect your GitHub, GitLab or Bitbucket repository and Hanzo takes care of building and deploying your app to your Kubernetes cluster when you push new code.

<p align="center">
<img width="960" height="245" src="https://github.com/hanzoai/paas/blob/main/hanzo.svg" alt="Hanzo logo"></img>
</p>

> For how to install, set up and use Hanzo please refer to its [documentation](https://hanzo.ai/getting-started).

## Key Features

Hanzo provides the following features:
- **Integration with [GitHub](https://github.com), [GitLab](https://gitlab.com) or [Bitbucket](https://bitbucket.com).** You can connect your git repo to your container in your Kubernetes cluster and whenever you push new code, Hanzo pulls the code, builds the docker image and deploys it.
- **Building docker images.** Under the hood we use [Kaniko](https://github.com/GoogleContainerTools/kaniko) to build container images from a Dockerfile. Through Hanzo Platform you can monitor build status and access to build logs.
- **Deploy docker images.** If you connect your git repo to your container in your cluster, Hanzo will automatically handle the build and deployment. Additionally, you can also deploy publicly available Docker images through Hanzo Platform.
- **Flexible networking settings.** For your containers, Hanzo can automatically generate a subdomain based ingress or you can define your own custom domain to expose your application services to the outside world. Additionally you can also enable/disable TCP proxying so that you can connect your containers through a dedicated port.
- **TLS certificates and wildcard domains.** Not only a standard domain but you can als define wildward subdomins for your containers and Hanzo automatically handles the TLS certificate issue and renewal.
- **One click deployment using build-in templates.** Hanzo comes with predefined templates for commonly used open-source platforms such as MongoDB, PostgreSQL, MySQL, MariaDB, Redis, Memcached and Minio. With one click you can easily deploy your database, cache or object storage.

## Community

We'd love to hear from you! [Join our Discord channel](https://discord.gg/5NhssWVm).

## How does Hanzo work?

Under the hood Hanzo uses several open source solutions and integrate them seamlessles. Basically, for each new container that you create and associate with your git repository we create a [Tekton](https://tekton.dev/) pipeline and register a webhook to your git repository to listen push events. Whenever you push your code updates to your repository this webhook is triggered and Tekton pipeline starts running.

There are three steps in the Tekton pipeline, which are executed in sequence and described below:
1. **Setup:** At this first step we clone your git repository to the Kubernetes cluster where Hanzo is running
2. **Build:** Using [Kaniko](https://github.com/GoogleContainerTools/kaniko), we build the OCI compliant docker image and push the image to the [Registy](https://distribution.github.io/distribution/) in your Kubernetes cluster.
3. **Deploy:** Using the pushed image, we change the image of your container in your Kubernetes cluster.

Please note that all setup, build and deploy operations are performed within your cluster and no data or files are transferred outside of your cluster.

## Installing and Setting up Hanzo

For how to install, set up and use Hanzo please refer to its [documentation](https://hanzo.ai). Alternatively, you can also have a look to [Hanzo Helm chart](https://github.com/hanzoai/paas-charts).

In short, you need to have an up and running Kubernetes cluster with at least 4CPUs and 8GB of memory and install the Hanzo Helm Chart to this cluster.

## Want to Contribute

See [CONTRIBUTING.md](https://github.com/hanzoai/paas/blob/main/CONTRIBUTING.md) for an overview of our processes.

If you are looking for support, enter an issue or join our [Join our Discord channel](https://discord.gg/5NhssWVm).
