from django.urls import include, path

API_PREFIX = "api/v1/"
urlpatterns = [path(API_PREFIX, include("api_urls"))]
