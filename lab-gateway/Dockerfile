FROM nginx:1.27-alpine
COPY lab-gateway/nginx.conf /etc/nginx/nginx.conf
COPY argocd-coach/src /usr/share/nginx/html/coach/assets
COPY argocd-coach/selectors /usr/share/nginx/html/coach/assets/selectors
COPY lab-launcher /usr/share/nginx/html/launcher
EXPOSE 8080
