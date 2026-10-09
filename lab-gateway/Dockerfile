FROM public.ecr.aws/docker/library/nginx:1.30.5-alpine3.24
COPY lab-gateway/nginx.conf /etc/nginx/nginx.conf.template
COPY lab-gateway/10-kubernetes-resolver.sh /docker-entrypoint.d/10-kubernetes-resolver.sh
RUN chmod 755 /docker-entrypoint.d/10-kubernetes-resolver.sh
COPY argocd-coach/src /usr/share/nginx/html/coach/assets
COPY argocd-coach/selectors /usr/share/nginx/html/coach/assets/selectors
COPY lab-launcher /usr/share/nginx/html/launcher
EXPOSE 8080
