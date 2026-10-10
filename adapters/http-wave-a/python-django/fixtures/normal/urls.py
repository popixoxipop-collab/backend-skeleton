from django.urls import include, path, re_path

import views

urlpatterns = [
    path("health/", views.health),
    path("items/<int:pk>/", views.item),
    re_path(r"^legacy/(?P<slug>[-\w]+)/$", views.legacy),
    path("api/", include("api_urls")),
]
