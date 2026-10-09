from django.urls import path

import views

urlpatterns = [path("ping/", views.ping)]
