from rest_framework import viewsets
from rest_framework.response import Response


class ItemViewSet(viewsets.ViewSet):
    def list(self, request):
        return Response([])

    def retrieve(self, request, pk=None):
        return Response({"id": pk})
