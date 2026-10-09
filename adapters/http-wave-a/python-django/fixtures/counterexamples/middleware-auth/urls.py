from django.contrib.auth.decorators import login_required
from django.urls import path

import views

urlpatterns = [
    path("public/", views.public),
    path("private/", login_required(views.private)),
]
