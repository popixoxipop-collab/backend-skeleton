from django.urls import include, path
from rest_framework.routers import SimpleRouter

import views

router = SimpleRouter()
router.register("items", views.ItemViewSet, basename="item")
urlpatterns = [path("api/", include(router.urls))]
