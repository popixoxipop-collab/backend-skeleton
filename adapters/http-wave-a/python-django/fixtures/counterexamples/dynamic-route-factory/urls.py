from django.urls import path

import views

NAMES = ["alpha", "beta"]
urlpatterns = [path(f"{name}/", views.make_view(name)) for name in NAMES]
